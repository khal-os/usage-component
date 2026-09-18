# shellcheck shell=bash
# CONTRATO §0.1 guard, as a function: lanes.test.sh runs it against the real
# branch, ecs-guard.test.sh against throwaway repos whose history is built on
# purpose. One implementation, so the fixtures prove the guard CI actually runs.

# The operational blocklist of the ECS pipeline — it only changes via main.
ECS_BLOCKLIST=(deploy/taskdefs deploy/tenants deploy/scripts deploy/langwatch deploy/Caddyfile .github/workflows)

# ecs_touched <base>
# Prints "<status> <path>" for every blocklisted file the eks side changed, run
# in the current repo against HEAD. A file counts only when BOTH hold:
#   1. it changed on this side since the fork (three-dot, merge-base..HEAD), so
#      main's own evolution never shows up here;
#   2. its content at HEAD differs from its content at <base>. The repo only
#      squash-merges, lane promotions included: a squash flattens history, so a
#      commit that reached eks/dev from main stops being an ancestor of
#      eks/homolog and eks/main, and (1) alone reports the file it touched even
#      though it is byte-identical to main.
# Returns non-zero when the three-dot diff cannot be computed (e.g. no
# merge-base), so the caller can say the guard was NOT measured.
ecs_touched() {
  local base="$1" candidates status path
  candidates="$(git diff --name-status --no-renames "${base}...HEAD" -- "${ECS_BLOCKLIST[@]}")" || return 1
  while IFS=$'\t' read -r status path; do
    [ -n "$path" ] || continue
    case "$path" in .github/workflows/eks-*) continue ;; esac
    # Absent on both sides also counts as equal. A failing diff prints the
    # path, so an error fails closed.
    git diff --quiet "$base" HEAD -- "$path" || printf '%s %s\n' "$status" "$path"
  done <<<"$candidates"
}
