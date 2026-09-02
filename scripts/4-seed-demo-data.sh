#!/usr/bin/env bash
#
# STEP 4 — demo data (DEV ONLY): premium-model prices and/or deterministic
# demo traffic for one client.
#
#   ./scripts/4-seed-demo-data.sh <name> [--prices] [--traces]
#
#   --prices   register the premium demo model's price versions (make
#              price runbook, insert-only, idempotent)
#   --traces   push this client's deterministic fixtures into its LangWatch
#              (requires onboarding)
#
# The fixtures themselves are generated on EVERY run, before either block:
# they are the dev discriminator `make seed-prices`/`make sync` gate on
# (decision 74), so generating them as a side effect of --traces made
# --prices unrunnable on a brand-new client.
#
# No flag = both. Ingestion into the platform store is the trace-ingestion-worker's
# job: pushed traces are indexed by LangWatch and picked up by the worker
# after the quiet period (~15-16 min). For instant ingestion use a manual
# backfill: make sync CLIENT=<name> FROM=... TO=...

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"; shift || true
require_envfile
banner 4 "dados demo — preços · tráfego"

DO_PRICES=0 DO_TRACES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prices) DO_PRICES=1; shift ;;
    --traces) DO_TRACES=1; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
if [[ "$DO_PRICES" -eq 0 && "$DO_TRACES" -eq 0 ]]; then
  DO_PRICES=1; DO_TRACES=1
fi

LANGWATCH_PORT="$(host_port LANGWATCH_PORT)"

# ---------- fixtures (ALWAYS, and FIRST) ----------
# demo-data/<cliente>/*.json é o discriminador DEV da decisão 74: `make
# seed-prices` e `make sync` se recusam a rodar sem ele. Gerar as fixtures
# aqui — antes do bloco de preços, e não como efeito colateral do bloco de
# traces — é o que faz um `./deploy-demo-client.sh <cliente-novo>` completar:
# `make up` só cria o diretório VAZIO, então a guarda derrubava o passo 4
# antes de qualquer coisa. Determinístico e idempotente (PRNG semeado por
# cliente): re-rodar reescreve os mesmos traces.
step "demo: gerando tráfego determinístico para '${NAME}'"
live node packages/connector/scripts/generate-demo-fixtures.mjs --client "${NAME}" \
  || die "geração de fixtures falhou"

# ---------- prices ----------
if [[ "$DO_PRICES" -eq 1 ]]; then
  step "demo: semeando a tabela de preços PoC (decisão 74 — antes migração 002)"
  live make seed-prices "CLIENT=${NAME}" || die "seed de preços PoC falhou"

  step "demo: registrando preços do modelo premium no banco"
  live ./packages/module/scripts/register-demo-prices.sh "${NAME}" || die "registro de preços falhou"
fi

# ---------- traces ----------
if [[ "$DO_TRACES" -eq 1 ]]; then
  # O passo 3 re-aplica a stack ao estampar o LANGWATCH_PROJECT_ID, o que
  # RECRIA o contêiner do LangWatch — empurrar tráfego enquanto ele ainda
  # reboota falha inteiro com "fetch failed" (0/N enviados). Espera limitada
  # até ele responder de novo; já no ar (re-run standalone) passa na hora.
  check_lw() { lw_ready "http://localhost:${LANGWATCH_PORT}"; }
  wait_live "demo: aguardando o LangWatch (o passo 3 recria o contêiner)" \
    "http://localhost:${LANGWATCH_PORT}" check_lw 60 5 \
    || die "LangWatch não voltou em http://localhost:${LANGWATCH_PORT} após 300s — veja: make logs CLIENT=${NAME}"

  # Decisão 127: a key não mora no env do cliente — o push a lê do Postgres
  # do LangWatch na hora (mesma fonte de onde o onboarding lê o project id).
  KEY_NOW="$(lw_project_key || true)"
  [[ -n "$KEY_NOW" ]] || die "LangWatch sem projeto/API key — rode ./scripts/3-onboard-langwatch.sh ${NAME} antes"

  step "demo: enviando o tráfego para o LangWatch do cliente"
  # tr '\r' '\n': o push reporta progresso com \r; via gutter cada tick
  # vira uma linha visível em vez de um carriage return perdido.
  live bash -c "set -o pipefail; LANGWATCH_API_KEY='${KEY_NOW}' node packages/connector/scripts/push-demo-to-langwatch.mjs '${NAME}' | tr '\r' '\n' | grep --line-buffered ." \
    || die "push para o LangWatch falhou"

  EXPECTED=$(python3 -c "import json,glob; print(sum(len(json.load(open(f))) for f in glob.glob('demo-data/${NAME}/*.json')))")
  printf '%s' "${CYN}▸${RST} ${B}demo: aguardando indexar ${EXPECTED} traces${RST}"
  INDEXED=0
  for _ in $(seq 1 36); do
    INDEXED=$(curl -s -m 10 -X POST "http://localhost:${LANGWATCH_PORT}/api/traces/search" \
      -H "X-Auth-Token: ${KEY_NOW}" -H 'Content-Type: application/json' \
      -d '{"pageSize":1,"pageOffset":0,"startDate":0,"endDate":1900000000000}' \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pagination",{}).get("totalHits",0))' 2>/dev/null || echo 0)
    [[ "${INDEXED:-0}" -ge "$EXPECTED" ]] && break
    echo -n "."; sleep 5
  done
  echo " ${INDEXED}/${EXPECTED}"
  [[ "${INDEXED:-0}" -ge "$EXPECTED" ]] || info "(indexação incompleta — o restante indexa em seguida)"

  QUIET_S="$(get TRACE_INGESTION_QUIET_PERIOD_SECONDS)"; QUIET_S="${QUIET_S:-900}"

  # With a short demo quarantine, watch the worker ingest live instead of
  # leaving a "come back later" note (bounded: quarantine + a few cycles).
  if (( QUIET_S <= 60 )); then
    INTERVAL_S="$(get TRACE_INGESTION_INTERVAL_SECONDS)"; INTERVAL_S="${INTERVAL_S:-60}"
    DEADLINE=$(( SECONDS + QUIET_S + INTERVAL_S * 3 + 30 ))
    printf '%s' "${CYN}▸${RST} ${B}demo: aguardando o trace-ingestion-worker ingerir (quarentena ${QUIET_S}s)${RST}"
    while (( SECONDS < DEADLINE )); do
      TOT=$(curl -s -m 5 "http://localhost:$(host_port API_PORT)/api/v1/traces?page=1&page_size=1" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo 0)
      [[ "${TOT:-0}" -ge "$EXPECTED" ]] && break
      echo -n "."; sleep 3
    done
    echo " ${TOT:-0}/${EXPECTED}"
  else
    info "ingestão contínua: o trace-ingestion-worker ingere após a quarentena (~$(( (QUIET_S + 59) / 60 ))-$(( (QUIET_S + 59) / 60 + 1 )) min);"
    info "para ingerir JÁ: make sync CLIENT=${NAME} FROM=$(date -u -d '14 days ago' +%F) TO=$(date -u -d 'tomorrow' +%F)"
  fi
fi

summary_data
