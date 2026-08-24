#!/usr/bin/env bash
# TESTE DA LISTA — deploy/services.sh e quem diz as lanes O QUE construir.
# Se ele mentir, a lane constroi a imagem errada e todo o resto fica verde.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$RAIZ"

TRAB="$(mktemp -d)"; trap 'rm -rf "$TRAB"' EXIT

titulo "saida do repo real"
IMGS="$(deploy/services.sh images)"
verifica "tres imagens declaradas" "3" "$(python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' <<<"$IMGS")"
verifica "nomes em ordem estavel" "usage-connector usage-db-backup usage-module" \
  "$(python3 -c 'import json,sys;print(" ".join(i["name"] for i in json.load(sys.stdin)))' <<<"$IMGS")"
contem "matrix no formato do GitHub" '"include"' "$(deploy/services.sh matrix)"

titulo "workloads: cinco, e o scheduler nasce desligado"
WL="$(deploy/services.sh workloads)"
verifica "cinco workloads" "5" "$(wc -l <<<"$WL" | tr -d ' ')"
contem "api usa usage-module"                    "api	Deployment	usage-module	true"                     "$WL"
contem "worker usa usage-connector"              "trace-ingestion-worker	Deployment	usage-connector	true"     "$WL"
contem "scheduler declarado e desabilitado"      "billing-close-scheduler	Deployment	usage-module	false"    "$WL"
contem "migrations e Job"                        "migrations	Job	usage-module	true"                          "$WL"
contem "backup e CronJob"                        "backup	CronJob	usage-db-backup	true"                        "$WL"

titulo "guards de coerencia"
# (1) workload apontando para imagem nao declarada
sed -e 's|      name: usage-connector|      name: usage-fantasma|' deploy/values.yaml > "${TRAB}/fantasma.yaml"
if KOS_VALUES_FILE="${TRAB}/fantasma.yaml" deploy/services.sh images >/dev/null 2>"${TRAB}/e1"; then
  falha "aceitou workload apontando para imagem nao declarada"
else
  contem "recusa imagem nao declarada" "nao esta em \`images:\`" "$(cat "${TRAB}/e1")"
fi

# (2) image.repository do workload divergindo de images:
python3 - "deploy/values.yaml" "${TRAB}/divergente.yaml" <<'PY'
import sys
origem, destino = sys.argv[1], sys.argv[2]
linhas = open(origem).read().splitlines(keepends=True)
saida, trocou = [], False
dentro = False
for l in linhas:
    if l.startswith("services:"):
        dentro = True
    if dentro and not trocou and "repository: 278522730053.dkr.ecr.sa-east-1.amazonaws.com/kos/usage-module" in l:
        l = l.replace("kos/usage-module", "kos/usage-outro")
        trocou = True
    saida.append(l)
assert trocou, "nao achei o repository do servico para divergir"
open(destino, "w").write("".join(saida))
PY
if KOS_VALUES_FILE="${TRAB}/divergente.yaml" deploy/services.sh images >/dev/null 2>"${TRAB}/e2"; then
  falha "aceitou image.repository divergindo de images:"
else
  contem "recusa repository divergente" "diverge de images." "$(cat "${TRAB}/e2")"
fi

# (3) entrada de imagem sem dockerfile
sed -e '/^    dockerfile: docker\/module.Dockerfile$/d' deploy/values.yaml > "${TRAB}/semdockerfile.yaml"
if KOS_VALUES_FILE="${TRAB}/semdockerfile.yaml" deploy/services.sh images >/dev/null 2>"${TRAB}/e3"; then
  falha "aceitou imagem sem dockerfile"
else
  contem "recusa imagem sem dockerfile" "sem \`dockerfile\`" "$(cat "${TRAB}/e3")"
fi

titulo "os Dockerfiles declarados existem"
while read -r df; do
  [ -f "$df" ] && ok "existe ${df}" || falha "declarado mas ausente: ${df}"
done <<<"$(python3 -c 'import json,sys;[print(i["dockerfile"]) for i in json.load(sys.stdin)]' <<<"$IMGS")"

encerra "services"
