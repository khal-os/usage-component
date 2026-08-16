#!/usr/bin/env bash
# Render the LangWatch EC2 user-data for a tenant, to stdout (decision 151).
#
#   bash deploy/scripts/render-user-data.sh <client>
#
# This is the ONE artifact we hand over instead of shipping: infra creates
# the instance WITH this file as its user-data. It is rendered once, not on
# every deploy, because cloud-init runs user-data exactly once per instance
# — everything that must change later (compose, Caddyfile, secrets,
# capacity) is re-fetched from S3/SM/SSM on every service start by
# langwatch-bootstrap.service, which is why only STABLE values live here.
#
# Do NOT hand this over before the domain is settled: LANGWATCH_PUBLIC_URL
# is baked into /opt/langwatch/tenant.conf at first boot, LangWatch
# validates its session auth against it, and the instance carries
# prevent_destroy — changing it later means rebuilding the box.
set -euo pipefail

CLIENT="${1:?usage: render-user-data.sh <client>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/naming.sh
source "${HERE}/naming.sh"
LANGWATCH_DIR="${LANGWATCH_DIR:-${HERE}/../langwatch}"

tenant_load "${CLIENT}"

SECRET_ARN="$(tget LANGWATCH_SECRET_ARN)"
[ -n "${SECRET_ARN}" ] || { echo "render-user-data: ${TENANT_FILE} declares no LANGWATCH_SECRET_ARN" >&2; exit 1; }

export UD_client_name="${CLIENT_NAME}"
export UD_region="${TENANT_REGION}"
export UD_secret_arn="${SECRET_ARN}"
export UD_capacity_param="$(ssm_param langwatch-capacity)"
export UD_compose_s3_uri="$(s3_config_uri langwatch-compose.yml)"
export UD_bootstrap_s3_uri="$(s3_config_uri langwatch-bootstrap.sh)"
export UD_langwatch_public_url="https://$(hostname_langwatch)"

TEMPLATE="${LANGWATCH_DIR}/langwatch-user-data.sh.tmpl" python3 <<'PY'
import os, string, sys


class UserDataTemplate(string.Template):
    """Only ${lowercase} is a placeholder.

    The file is a shell script: it is full of $VAR and ${VAR%/*} that
    belong to the BOX, not to us. Terraform's templatefile had the same
    split (it resolved ${…} and the template therefore uses only lowercase
    names for its own slots), so restricting the pattern this way keeps
    the exact semantics the file was written against.
    """

    pattern = r"""
        \$(?:
            (?P<escaped>\$)                        |
            (?P<named>(?!))                        |
            \{(?P<braced>[a-z_][a-z0-9_]*)\}       |
            (?P<invalid>(?!))
        )
    """


values = {k[3:]: v for k, v in os.environ.items() if k.startswith("UD_")}
blank = sorted(k for k, v in values.items() if not v)
if blank:
    sys.exit("render-user-data: no value for " + ", ".join(blank))

with open(os.environ["TEMPLATE"], encoding="utf-8") as fh:
    template = UserDataTemplate(fh.read())

try:
    # safe_substitute would let an unresolved ${placeholder} reach a box
    # that boots exactly once. substitute raises instead.
    sys.stdout.write(template.substitute(values))
except KeyError as missing:
    sys.exit(f"render-user-data: template placeholder {missing} has no value")
PY
