#!/usr/bin/env bash
# Config-secrets lint: TRACKED config files (env/tfvars) may hold IDENTIFIERS
# and ADDRESSES, never values that grant access. The test: "if this file
# leaked publicly, does anyone gain access?" — a key that answers yes belongs
# in a Secrets Manager shell, not in git.
#
# Complements gitleaks/TruffleHog (generic, repo-wide) by being strict and
# semantic exactly where per-client config lives. False positive? Append
#   # lint:allow-config-value
# to the line with a comment justifying WHY the value grants no access.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FILES=$(git ls-files -- '*.env' '.env*' '*.env.*' '*.tfvars' ':!:*node_modules*' 2>/dev/null || true)
[ -n "$FILES" ] || { echo "config-secrets: no tracked config files"; exit 0; }

FAIL=0
flag() { # <file> <lineno> <reason> <line>
  FAIL=1
  printf 'config-secrets: %s:%s — %s\n    %s\n' "$1" "$2" "$3" "$4" >&2
}

is_placeholder() { # value — true when the value is obviously not a credential
  local v="$1"
  [ -z "$v" ] && return 0
  case "$v" in
    PLACEHOLDER*|CHANGE_ME*|changeme*|change-me*|TODO*|null|none|false|true) return 0 ;;
    \<*\>|\$\{*\}|\$[A-Z_]*) return 0 ;;
    *example*|*EXAMPLE*|*your-*|*YOUR_*|*fixture*|*FIXTURE*|xxx*|XXX*) return 0 ;;
  esac
  return 1
}

while IFS= read -r file; do
  [ -f "$file" ] || continue
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    case "$line" in
      *"# lint:allow-config-value"*) continue ;;
      \#*|"") continue ;;
    esac

    # (a) access-granting KEY names with a real value
    # Key must END with the sensitive word: TOKEN matches, TOKEN_AUDIENCE and
    # COOKIE_SECRET_ARN (a pointer, not a value) do not.
    if printf '%s' "$line" | grep -qiE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_.]*(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|SIGNING_KEY)[[:space:]]*=' ; then
      value=$(printf '%s' "$line" | sed -E 's/^[^=]*=[[:space:]]*//; s/^["'"'"']//; s/["'"'"'][[:space:]]*(#.*)?$//; s/[[:space:]]*#.*$//')
      if ! is_placeholder "$value"; then
        flag "$file" "$lineno" "access-granting key with a real value" "$line"
      fi
    fi

    # (b) credential SIGNATURES regardless of key name
    if printf '%s' "$line" | grep -qE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|sk_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ'; then
      flag "$file" "$lineno" "credential signature" "$line"
    fi
  done < "$file"
done <<< "$FILES"

if [ "$FAIL" -ne 0 ]; then
  echo >&2
  echo "config-secrets: a value that grants access never lives in git — move it to the secret store (a Secrets Manager shell) and reference it by name/ARN." >&2
  exit 1
fi
echo "config-secrets: clean ($(echo "$FILES" | wc -l) files)"
