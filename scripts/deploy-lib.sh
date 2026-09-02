# Shared helpers for the deploy step scripts (sourced, never executed).
# Each step script is independently runnable:
#   ./scripts/<step>.sh <name> [options]
# and deploy-demo-client.sh orchestrates them in order. Conventions here:
# $NAME (validated slug), $ENVFILE, colored output, live container tree.

set -euo pipefail

# ---------- output helpers (colors only on a terminal) ----------
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; CYN=$'\033[36m'
  YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
else
  B='' DIM='' GRN='' CYN='' YLW='' RED='' RST=''
fi

step()  { printf '%s\n' "${CYN}▸${RST} ${B}$*${RST}"; }
info()  { printf '%s\n' "  ${DIM}$*${RST}"; }
sub()   { printf '  %s %s\n' "${DIM}·${RST}" "$*"; }
die()   { printf '%s\n' "${RED}✖ ERRO:${RST} $*" >&2; exit 1; }

# Step banner: every step script announces itself the same way, whether
# run standalone or via the orchestrator — number first, so the sequence
# is impossible to miss. Call AFTER require_name. Usage: banner <n> <título>
BANNER_RULE="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
banner() {
  printf '\n%s\n' "${CYN}${BANNER_RULE}${RST}"
  printf '%s\n' " ${B}${CYN}[$1/5]${RST} ${B}$2${RST}   ${DIM}cliente: ${NAME}${RST}"
  printf '%s\n' "${CYN}${BANNER_RULE}${RST}"
}

# Run a command streaming its output LIVE under the current step — every
# line shown as it happens behind a dim │ gutter, closed by ✔/✖ + elapsed.
# Nothing is swallowed: what the tool prints is what the operator watches.
live() {
  local t0=$SECONDS rc=0
  "$@" 2>&1 | sed -u "s/^/  ${DIM}│ /;s/\$/${RST}/" || rc=$?
  if (( rc == 0 )); then
    printf '  %s✔%s %s%ds%s\n' "$GRN" "$RST" "$DIM" "$(( SECONDS - t0 ))" "$RST"
  else
    printf '  %s✖ falhou%s %s(%ds)%s\n' "$RED" "$RST" "$DIM" "$(( SECONDS - t0 ))" "$RST"
  fi
  return $rc
}

line() { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${RST}"; }
row()  { printf '   %s%-12s%s %s\n' "$B" "$1" "$RST" "$2"; }

# ---------- summary sections ----------
# Each step closes by printing ITS slice of the final summary (the full
# picture stays in 5-verify-client.sh): env → ACESSOS · provisão →
# OPERAÇÃO · onboarding → CREDENCIAIS · seed → DADOS.

summary_access() {
  local api_port mongo_port api_url lw_url
  api_port="$(host_port API_PORT)"
  mongo_port="$(get MONGO_HOST_PORT)"
  # Public URLs come from the env file — MODULE_PUBLIC_URL is print-only
  # (absent = localhost), LANGWATCH_PUBLIC_URL is the compose-required knob.
  api_url="$(get MODULE_PUBLIC_URL)"; lw_url="$(get LANGWATCH_PUBLIC_URL)"
  echo
  printf '  %s\n' "${CYN}ACESSOS${RST}"
  row "API"       "${api_url:-http://localhost:${api_port}}/api/v1"
  row "API docs"  "http://localhost:${api_port}/api/v1/docs/"
  row "LangWatch" "${lw_url:-${YLW}defina LANGWATCH_PUBLIC_URL em ${ENVFILE}${RST}}"
  # MONGO_HOST_PORT tem default 0 no compose (porta efêmera) — não há URL
  # estável a imprimir quando ele está ausente, então diga isso.
  if [[ -n "$mongo_port" ]]; then
    row "Mongo dev" "mongodb://localhost:${mongo_port}/?directConnection=true   ${DIM}(db: ${NAME})${RST}"
  else
    row "Mongo dev" "${DIM}sem porta fixa — defina MONGO_HOST_PORT em ${ENVFILE} (compose publica em porta efêmera)${RST}"
  fi
}

summary_credentials() {
  local email="admin@${NAME}.com" password
  password="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): admin@${NAME}.com / ).*" "$ENVFILE" | head -1 || true)"
  echo
  printf '  %s   %s\n' "${CYN}CREDENCIAIS LANGWATCH${RST}" "${YLW}⚠ guarde — a senha não é recuperável${RST}"
  row "login" "${email}"
  if [[ -n "$password" ]]; then
    row "senha" "${B}${password}${RST}   ${DIM}(também em ${ENVFILE})${RST}"
  else
    row "senha" "${DIM}(não registrada em ${ENVFILE} — onboarding manual ou comentário removido)${RST}"
  fi
}

summary_data() {
  # total_display, não total: passado o teto de contagem (decisão 77/79) a
  # API responde `total: 10000, total_display: "10.000+"` — imprimir o
  # número cru diria "10000 ingeridos" para um arquivo de 50 mil.
  local total
  total=$(curl -s -m 8 "http://localhost:$(host_port API_PORT)/api/v1/traces?page=1&page_size=1" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_display"])' 2>/dev/null || echo '?')
  echo
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "traces" "${total} ingeridos na plataforma"
  if [[ "$total" == "0" ]]; then
    local quiet_s; quiet_s="$(get TRACE_INGESTION_QUIET_PERIOD_SECONDS)"; quiet_s="${quiet_s:-900}"
    row "" "${DIM}o trace-ingestion-worker ingere continuamente (quarentena ~$(( (quiet_s + 59) / 60 )) min);${RST}"
    row "" "${DIM}acompanhe com: make logs CLIENT=${NAME} (linhas 'Sync: batch')${RST}"
  fi
}

summary_operation() {
  echo
  printf '  %s\n' "${CYN}OPERAÇÃO${RST}"
  row "logs"     "make logs CLIENT=${NAME}   ${DIM}(trace-ingestion-worker: linhas 'Sync: batch')${RST}"
  row "backfill" "make sync CLIENT=${NAME} FROM=YYYY-MM-DD TO=YYYY-MM-DD   ${DIM}(manual/opcional)${RST}"
  row "parar"    "make down CLIENT=${NAME}   ${DIM}(dados preservados)${RST}"
  row "backup"   "make backup CLIENT=${NAME}   ${DIM}(mongodump -> backups/ — o arquivo permanente)${RST}"
  row "apagar"   "docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file ${ENVFILE} down -v   ${DIM}(faça make backup antes)${RST}"
}

# ---------- client name + env file ----------
# require_name <name-arg>: validates the slug and sets NAME/ENVFILE.
require_name() {
  NAME="${1:-}"
  [[ -n "$NAME" ]] || die "uso: $0 <name> [options]"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "nome deve ser um slug ([a-z][a-z0-9-]+): '$NAME'"
  ENVFILE="clients/${NAME}.env"
}

require_envfile() {
  [[ -f "$ENVFILE" ]] || die "faltando ${ENVFILE} — rode ./scripts/1-init-client-env.sh ${NAME} primeiro"
}

# `|| true`: a var absent from the env file is a NORMAL state (the contract
# invites omitting optional knobs) — without it, grep's exit 1 rides
# pipefail/set -e and kills the caller with no message, turning every
# `${VAR:-default}` fallback after a get() into dead code.
get() { grep -oP "(?<=^$1=).*" "$ENVFILE" | head -1 || true; }

# Published host port of a service, WITH the compose default applied.
# NEVER build a URL from a bare `get API_PORT`: the env contract explicitly
# invites omitting these vars on a dedicated host, get() answers empty for
# an absent var, and "http://localhost:/api/v1" is normalized by curl to
# port 80 — which is how the auth fail-closed smoke check came to read 000
# forever and blame auth forwarding for a URL-construction bug.
# The defaults MUST track compose.module.yml / compose.connector.yml.
host_port() {
  local default value
  case "$1" in
    API_PORT)       default=3000 ;;
    LANGWATCH_PORT) default=5560 ;;
    *) printf '%s\n' "host_port: sem default conhecido para '$1'" >&2; return 1 ;;
  esac
  value="$(get "$1")"
  printf '%s' "${value:-$default}"
}

# Escape a value for the REPLACEMENT side of a sed s|…|…| on the env file:
# `&` (whole-match), `\` (escape) and `|` (our delimiter) are metacharacters
# there — an API key containing any of them would corrupt the write.
sed_escape() { printf '%s' "$1" | sed -e 's/[&\|]/\\&/g'; }

# LangWatch readiness probe against a base URL (no trailing slash).
# 200/302/307 all mean "up" — the root redirects to auth or onboarding
# depending on instance state. Meant as the body of a wait_live check:
#   check_lw() { lw_ready "http://localhost:${LANGWATCH_PORT}"; }
lw_ready() {
  local c
  c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1/" 2>/dev/null || true)
  [[ "$c" == "200" || "$c" == "302" || "$c" == "307" ]]
}

# LangWatch's own Postgres is the source of truth for project id and API
# key (decisão 127: nada disso mora em contêiner nosso; a key nem no env —
# o pipeline de demo a lê daqui na hora do push, e um cliente real copia
# da UI para o vault).
lw_project_id() {
  docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
    -c 'SELECT id FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1
}

lw_project_key() {
  docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
    -c 'SELECT "apiKey" FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1
}

# Append a line to the env file, healing a missing trailing newline first —
# appending onto a file whose last line lacks \n would CONCATENATE onto it
# (seen in the wild: REPROCESS_INTERVAL_SECONDS=3600# LangWatch admin ...,
# which crash-looped the trace-ingestion-worker on config validation).
append_env_line() {
  [[ -s "$ENVFILE" && -n "$(tail -c1 "$ENVFILE")" ]] && echo >> "$ENVFILE"
  printf '%s\n' "$1" >> "$ENVFILE"
}

# ---------- live container tree ----------
# One line per container of this client's stack, in docker compose's own
# visual language (` Container <name>  <Status>`), status colored by health
# (verde = up/healthy, amarelo = starting, vermelho = down).
containers() {
  local rows i cname cstatus color
  mapfile -t rows < <(docker ps -a --filter "label=com.docker.compose.project=${NAME}" \
    --format '{{.Names}}\t{{.Status}}' | sort)
  for i in "${!rows[@]}"; do
    cname="${rows[$i]%%$'\t'*}"; cstatus="${rows[$i]#*$'\t'}"
    case "$cstatus" in
      *starting*)          color="$YLW" ;;
      *healthy*|Up*)       color="$GRN" ;;
      *)                   color="$RED" ;;
    esac
    printf ' %sContainer %-34s%s %s%s%s\n' "$DIM" "$cname" "$RST" "$color" "$cstatus" "$RST"
  done
}

# Live wait: while polling a readiness check, redraws the container tree IN
# PLACE (TTY) with a footer showing the target and elapsed time — the stack's
# health dots update in real time as containers come up. Non-TTY (CI/pipes)
# falls back to the classic dots. Usage: wait_live <rótulo> <alvo> <check_fn> <tentativas> <intervalo>
wait_live() {
  local label="$1" target="$2" check="$3" tries="$4" delay="$5"
  local i lines=0 t0=$SECONDS ok=0 block footer
  step "$label"
  if [[ ! -t 1 ]]; then
    for ((i = 0; i < tries; i++)); do
      "$check" && { ok=1; break; }
      echo -n "."; sleep "$delay"
    done
    [[ "$ok" -eq 1 ]] && echo " ok" || echo " timeout"
    return $(( 1 - ok ))
  fi
  for ((i = 0; i < tries; i++)); do
    "$check" && ok=1
    if [[ "$ok" -eq 1 ]]; then
      footer="  ${GRN}✔${RST} ${target} ${DIM}· $(( SECONDS - t0 ))s${RST}"
    else
      footer="  ${DIM}⏳ ${target} · $(( SECONDS - t0 ))s${RST}"
    fi
    block="$(containers)"$'\n'"$footer"
    (( lines > 0 )) && printf '\033[%dA\033[0J' "$lines"
    printf '%s\n' "$block"
    lines=$(printf '%s\n' "$block" | wc -l)
    [[ "$ok" -eq 1 ]] && return 0
    sleep "$delay"
  done
  return 1
}
