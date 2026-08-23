#!/usr/bin/env bash
# TESTE DO PIN — deploy/gitops-pin.sh e o unico script da esteira que ESCREVE no
# git. Os casos abaixo provam o que ele tem de RECUSAR e as duas propriedades das
# quais a esteira inteira depende:
#   · o commit toca EXATAMENTE UM arquivo — e o que faz o `paths-ignore` das
#     lanes funcionar como guarda anti-laco;
#   · o que o chart RENDERIZA e o conjunto pinado, nao o que o arquivo aparenta.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$RAIZ"

for bin in git helm python3 jq; do command -v "$bin" >/dev/null || { echo "FALTA: $bin"; exit 1; }; done

TRAB="$(mktemp -d)"; trap 'rm -rf "$TRAB"' EXIT
D_MOD="sha256:$(printf 'a%.0s' $(seq 64))"
D_CON="sha256:$(printf 'b%.0s' $(seq 64))"
D_BAK="sha256:$(printf 'c%.0s' $(seq 64))"
SHA1="$(printf 'd%.0s' $(seq 40))"
SHA2="$(printf 'e%.0s' $(seq 40))"
BLOCO="{\"usage-module\":\"${D_MOD}\",\"usage-connector\":\"${D_CON}\",\"usage-db-backup\":\"${D_BAK}\"}"

novo_repo() { # novo_repo <nome> -> imprime o caminho do clone de trabalho
  local base="${TRAB}/$1"
  rm -rf "$base"; mkdir -p "$base/work/deploy"
  git init -q --bare "$base/remote"
  cp -R "${RAIZ}/deploy/chart" "$base/work/deploy/chart"
  cp "${RAIZ}/deploy/values.yaml" "${RAIZ}"/deploy/values-*.yaml \
     "${RAIZ}/deploy/services.sh" "${RAIZ}/deploy/gitops-pin.sh" "$base/work/deploy/"
  ( cd "$base/work" && git init -q -b eks/dev . \
      && git config user.email t@t && git config user.name teste \
      && git add -A && git commit -q -m init && git remote add origin "$base/remote" )
  echo "$base/work"
}

roda() { ( cd "$1" && shift && GITOPS_PIN_SKIP_PUSH=1 ./deploy/gitops-pin.sh "$@" 2>&1 ) }

titulo "recusa entradas invalidas"
W="$(novo_repo recusas)"
SAIDA="$(roda "$W" producao "$BLOCO" "$SHA1")"        ; contem "ambiente invalido" "ambiente invalido" "$SAIDA"
SAIDA="$(roda "$W" dev 'nao-e-json' "$SHA1")"          ; contem "bloco nao-JSON"    "JSON"              "$SAIDA"
SAIDA="$(roda "$W" dev "$BLOCO" 'sha-curto')"          ; contem "git-sha invalido"  "40 hex"            "$SAIDA"
SAIDA="$(roda "$W" dev "{\"usage-module\":\"dev-abc123\",\"usage-connector\":\"${D_CON}\",\"usage-db-backup\":\"${D_BAK}\"}" "$SHA1")"
contem "tag no lugar de digest" "fora do formato" "$SAIDA"
SAIDA="$(roda "$W" dev "{\"usage-module\":\"${D_MOD}\"}" "$SHA1")"
contem "bloco parcial e recusado" "NAO pina" "$SAIDA"
SAIDA="$(roda "$W" dev "{\"usage-module\":\"${D_MOD}\",\"usage-connector\":\"${D_CON}\",\"usage-db-backup\":\"${D_BAK}\",\"intruso\":\"${D_MOD}\"}" "$SHA1")"
contem "imagem nao declarada e recusada" "nao declara" "$SAIDA"
ZEROS="sha256:$(printf '0%.0s' $(seq 64))"
SAIDA="$(roda "$W" dev "{\"usage-module\":\"${ZEROS}\",\"usage-connector\":\"${D_CON}\",\"usage-db-backup\":\"${D_BAK}\"}" "$SHA1")"
contem "placeholder e recusado" "PLACEHOLDER" "$SAIDA"
verifica "nenhum commit foi criado nas recusas" "1" "$( (cd "$W" && git rev-list --count HEAD) )"

titulo "HOLD trava o ambiente e FALHA (nao pula)"
W="$(novo_repo hold)"
echo "congelado pelo owner ate a janela de terca" > "$W/deploy/HOLD-dev"
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA1")"
contem "HOLD-dev bloqueia"        "HOLD ativo"  "$SAIDA"
contem "HOLD imprime o motivo"    "janela de terca" "$SAIDA"
verifica "HOLD nao commitou nada" "1" "$( (cd "$W" && git rev-list --count HEAD) )"
rm "$W/deploy/HOLD-dev"
echo "freeze global" > "$W/deploy/HOLD"
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA1")"
contem "HOLD global bloqueia" "HOLD ativo" "$SAIDA"

titulo "caminho feliz"
W="$(novo_repo feliz)"
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA1")"
contem "guard de render aprovou o conjunto" "guard_render: o chart resolve exatamente o conjunto pinado" "$SAIDA"
contem "GIT_SHA chega ao render"            "GIT_SHA=${SHA1}"                                            "$SAIDA"
verifica "criou UM commit" "2" "$( (cd "$W" && git rev-list --count HEAD) )"
verifica "o commit toca EXATAMENTE um arquivo" "deploy/values-dev.yaml" \
  "$( (cd "$W" && git show --pretty=format: --name-only HEAD | sed '/^$/d') )"
contem "autor e o bot de release" "khal-release-bot" "$( (cd "$W" && git log -1 --format='%an') )"
contem "digest do module gravado"    "$D_MOD" "$(cat "$W/deploy/values-dev.yaml")"
contem "digest do connector gravado" "$D_CON" "$(cat "$W/deploy/values-dev.yaml")"
contem "digest do backup gravado"    "$D_BAK" "$(cat "$W/deploy/values-dev.yaml")"
contem "comentarios preservados"     "ESCRITO POR deploy/gitops-pin.sh" "$(cat "$W/deploy/values-dev.yaml")"

titulo "idempotencia: repetir o MESMO bloco nao cria commit novo"
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA1")"
contem "reconhece que ja estava pinado" "ja estava neste bloco" "$SAIDA"
verifica "continua com 2 commits" "2" "$( (cd "$W" && git rev-list --count HEAD) )"

titulo "re-pin com outro sha cria commit novo, ainda com um arquivo so"
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA2")"
verifica "tres commits" "3" "$( (cd "$W" && git rev-list --count HEAD) )"
verifica "um arquivo por commit" "deploy/values-dev.yaml" \
  "$( (cd "$W" && git show --pretty=format: --name-only HEAD | sed '/^$/d') )"

titulo "guard de render reprova quando o chart nao resolve o que foi pinado"
# Cenario real: alguem escreve um digest FIXO em deploy/values.yaml (a forma), e
# ele passa a vencer o pin do ambiente. O arquivo do ambiente fica bonito e o
# cluster roda outra coisa — e exatamente isso que o guard existe para pegar.
W="$(novo_repo guard)"
python3 - "$W/deploy/values.yaml" "$D_BAK" <<'PY'
import re, sys
arquivo, fixo = sys.argv[1], sys.argv[2]
texto = open(arquivo).read()
# o primeiro `digest: ""` do arquivo pertence ao servico `api` (usage-module)
texto = texto.replace('      digest: ""', '      digest: "%s"' % fixo, 1)
open(arquivo, "w").write(texto)
PY
SAIDA="$(roda "$W" dev "$BLOCO" "$SHA1")"
contem "guard reprova conjunto divergente" "guard_render=fail" "$SAIDA"
verifica "nada foi commitado" "1" "$( (cd "$W" && git rev-list --count HEAD) )"

encerra "gitops-pin"
