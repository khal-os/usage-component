#!/usr/bin/env bash
# O ULTIMO PASSO DO DEPLOY: escrever os digests em deploy/values-<env>.yaml e
# COMMITAR. Este repositorio E o repositorio GitOps do chart — a Application do
# Argo aponta para `path: deploy/chart` com `targetRevision` = a branch do
# ambiente, entao "fazer deploy" aqui significa, literalmente, escrever o pin.
#
#   uso: deploy/gitops-pin.sh <dev|hml|prod> '<json {"imagem":"sha256:..."}>' <git-sha-40hex>
#   ex.: deploy/gitops-pin.sh dev '{"usage-module":"sha256:aa..","usage-connector":"sha256:bb..","usage-db-backup":"sha256:cc.."}' $GITHUB_SHA
#
# MULTI-IMAGEM DE PROPOSITO. O repo publica TRES imagens e CINCO workloads as
# compartilham (api, billing-close-scheduler e o Job de migracao rodam o mesmo
# usage-module). Pinar uma de cada vez daria tres commits, tres syncs do Argo e
# uma janela em que a api nova conversa com o schema velho. O bloco inteiro
# entra num commit so.
#
# O DIGEST MORA NO ARQUIVO, no git — nunca em `spec.source.helm.parameters` da
# Application (la ele some num `kubectl delete application` e nao aparece em
# `git log` nenhum).
#
# ROLLBACK = `git revert` deste commit. Nunca `helm rollback` / `kubectl rollout
# undo`: o selfHeal do Argo desfaz os dois em segundos.
#
# ⚠ A migracao e hook PreSync e e FORWARD-ONLY: o revert devolve o CODIGO ao
# digest anterior; o SCHEMA fica onde esta.
#
# ANTI-LACO: este commit toca UM unico arquivo (o values do ambiente), e cada
# lane tem `paths-ignore` exatamente nesse arquivo. Nao usamos `[skip ci]` — a
# marca no assunto do commit qualquer um apaga sem perceber, e o Actions a aplica
# a run inteira, inclusive as lanes que PRECISAM ver o commit.
set -Eeuo pipefail

AMBIENTE="${1:?uso: gitops-pin.sh <dev|hml|prod> '<json imagem->digest>' <git-sha>}"
BLOCO="${2:?uso: gitops-pin.sh <dev|hml|prod> '<json imagem->digest>' <git-sha>}"
SHA="${3:-${GITHUB_SHA:-}}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

erro() { echo "::error::gitops-pin: $*" >&2; exit 1; }

case "$AMBIENTE" in dev | hml | prod) ;; *) erro "ambiente invalido: '${AMBIENTE}' (use dev, hml ou prod)" ;; esac
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || erro "git-sha precisa ser 40 hex minusculos, recebi: '${SHA}'"

CHART_DIR="deploy/chart"
VALUES_BASE="deploy/values.yaml"
VALUES="deploy/values-${AMBIENTE}.yaml"
[ -f "$VALUES" ] || erro "values do ambiente nao encontrado: ${VALUES} (rode a partir de qualquer lugar; o script se localiza sozinho)"

for bin in git helm python3 jq; do command -v "$bin" >/dev/null || erro "falta '${bin}' no PATH"; done

# ── HOLD: freeze manual, fail-closed ────────────────────────────────────────
# `deploy/HOLD` congela os tres ambientes; `deploy/HOLD-<env>` congela um. O
# HOLD FALHA a lane em vez de sair 0: um "pulei o deploy" verde e indistinguivel
# de um "deploy feito" na lista de execucoes, e e assim que um freeze vira
# surpresa tres dias depois.
for hold in "deploy/HOLD" "deploy/HOLD-${AMBIENTE}"; do
  if [ -f "$hold" ]; then
    echo "::error::gitops-pin: HOLD ativo em ${hold} — nenhum pin foi escrito." >&2
    echo "--- motivo declarado em ${hold} ---" >&2
    sed -e 's/^/  /' "$hold" >&2
    echo "--- remova o arquivo (e commite) para liberar o ambiente ${AMBIENTE} ---" >&2
    exit 1
  fi
done

# A lista autoritativa de imagens (nome -> repositorio) sai de deploy/values.yaml
# via deploy/services.sh, que ja carrega o YAML de verdade e ja roda o guard de
# coerencia entre `images:` e os workloads. Reimplementar isso aqui criaria uma
# segunda opiniao sobre o que existe.
REPOS_JSON="$(deploy/services.sh repos)" || erro "deploy/services.sh repos falhou"

echo "→ pinando ${AMBIENTE} (git-sha ${SHA})"
jq -r 'to_entries[] | "  · \(.key) = \(.value)"' <<<"$BLOCO" 2>/dev/null \
  || erro "o bloco de pins nao e JSON valido. Esperado: {\"usage-module\":\"sha256:...\", ...}"

# ── escreve o pin (reescrita cirurgica, preservando comentarios) ─────────────
python3 - "$VALUES" "$BLOCO" "$SHA" "$REPOS_JSON" <<'PY'
import json, re, sys

arquivo, bruto, sha, repos_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def morre(msg):
    print("::error::gitops-pin: " + msg, file=sys.stderr)
    sys.exit(1)

try:
    bloco = json.loads(bruto)
except Exception as exc:
    morre("o bloco de pins nao e JSON valido (%s)" % exc)
if not isinstance(bloco, dict) or not bloco:
    morre("o bloco de pins tem de ser um objeto JSON nao vazio imagem->digest")

declaradas = set(json.loads(repos_json))
desconhecidas = sorted(set(bloco) - declaradas)
if desconhecidas:
    morre("o bloco pina imagens que `images:` de deploy/values.yaml nao declara: %s "
          "(declaradas: %s). Pinar uma imagem que o chart nunca renderiza deixa a lane "
          "verde e o deploy inexistente." % (", ".join(desconhecidas), ", ".join(sorted(declaradas))))
faltando = sorted(declaradas - set(bloco))
if faltando:
    morre("o bloco NAO pina %s. O pin e do conjunto inteiro: pinar um subconjunto deixaria "
          "workloads no digest anterior e a esteira mentindo sobre o que esta no ar."
          % ", ".join(faltando))

# Tag e mutavel; digest nao. Promover por tag e como o "mesmo" build virar dois
# binarios diferentes entre homolog e producao.
zeros = "sha256:" + "0" * 64
for nome, digest in sorted(bloco.items()):
    if not re.match(r"^sha256:[0-9a-f]{64}$", str(digest)):
        morre("digest de '%s' fora do formato sha256:<64 hex minusculos>: '%s'" % (nome, digest))
    if digest == zeros:
        morre("digest de '%s' e o PLACEHOLDER de branch nunca buildada — nada a pinar" % nome)

linhas = open(arquivo).read().splitlines(keepends=True)

inicio = None
for i, l in enumerate(linhas):
    if re.match(r"^pins:\s*$", l):
        inicio = i
        break
if inicio is None:
    morre("%s nao tem bloco `pins:` de primeiro nivel" % arquivo)

fim = len(linhas)
for i in range(inicio + 1, len(linhas)):
    l = linhas[i]
    if l.strip() and not l.startswith((" ", "\t")):
        fim = i
        break

# Mapeia as chaves de imagem ja presentes no bloco: nome -> (inicio, fim).
chaves = []
for i in range(inicio + 1, fim):
    m = re.match(r"^  ([A-Za-z0-9][A-Za-z0-9._-]*):\s*$", linhas[i])
    if m:
        chaves.append((m.group(1), i))
limites = {}
for idx, (nome, pos) in enumerate(chaves):
    prox = chaves[idx + 1][1] if idx + 1 < len(chaves) else fim
    limites[nome] = (pos, prox)

def escreve(nome, digest):
    ini, prox = limites[nome]
    achou_d = achou_s = False
    for i in range(ini + 1, prox):
        md = re.match(r"^(\s+)digest:\s*.*$", linhas[i])
        if md:
            linhas[i] = '%sdigest: "%s"\n' % (md.group(1), digest); achou_d = True; continue
        ms = re.match(r"^(\s+)gitSha:\s*.*$", linhas[i])
        if ms:
            linhas[i] = '%sgitSha: "%s"\n' % (ms.group(1), sha); achou_s = True
    if not achou_d:
        morre("%s: `%s` dentro de `pins:` nao tem chave `digest:`" % (arquivo, nome))
    if not achou_s:
        linhas.insert(ini + 1, '    gitSha: "%s"\n' % sha)

novas = []
for nome in sorted(bloco):
    if nome in limites:
        escreve(nome, bloco[nome])
    else:
        novas.append(nome)

# Imagem nova (declarada em images: mas ainda sem entrada no values do ambiente):
# entra no fim do bloco, com os dois campos.
if novas:
    trecho = []
    for nome in novas:
        trecho.append("  %s:\n" % nome)
        trecho.append('    digest: "%s"\n' % bloco[nome])
        trecho.append('    gitSha: "%s"\n' % sha)
    linhas[fim:fim] = trecho

orfas = sorted(set(limites) - set(bloco))
if orfas:
    print("::warning::gitops-pin: %s tem pins de imagens que `images:` nao declara mais: %s"
          % (arquivo, ", ".join(orfas)), file=sys.stderr)

open(arquivo, "w").write("".join(linhas))
PY

# ── guard de render ─────────────────────────────────────────────────────────
# O que o Argo vai APLICAR e o `helm template` deste chart com este values — nao
# o que o arquivo parece dizer. Sem este guard, um pin escrito na chave errada
# deixa a lane verde enquanto o cluster segue na imagem antiga.
#
# O criterio e por CONJUNTO: o conjunto de `image:` renderizado tem de ser
# exatamente o conjunto de repo@digest das imagens usadas por workloads
# HABILITADOS. Nem a mais (imagem que ninguem declarou), nem a menos (workload
# que ficou no digest velho).
NS_RENDER="kos-components"
[ "$AMBIENTE" = "prod" ] || NS_RENDER="kos-components-${AMBIENTE}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! helm template kos-components "$CHART_DIR" --namespace "$NS_RENDER" \
      -f "$VALUES_BASE" -f "$VALUES" > "${TMP}/render.yaml" 2> "${TMP}/render.err"; then
  echo "::error::gitops-pin: guard_render=fail — o chart nem renderiza com ${VALUES}. Saida do helm:" >&2
  sed -e 's/^/  /' "${TMP}/render.err" >&2
  exit 1
fi

ESPERADAS="$(
  deploy/services.sh workloads \
    | awk -F'\t' '$4 == "true" { print $3 }' \
    | sort -u \
    | while read -r img; do
        repo="$(jq -r --arg k "$img" '.[$k]' <<<"$REPOS_JSON")"
        dig="$(jq -r --arg k "$img" '.[$k]' <<<"$BLOCO")"
        echo "${repo}@${dig}"
      done | sort -u
)"
ENCONTRADAS="$(awk '$1 == "image:" { gsub(/"/, "", $2); print $2 }' "${TMP}/render.yaml" | sort -u)"

if [ "$ESPERADAS" != "$ENCONTRADAS" ]; then
  echo "::error::gitops-pin: guard_render=fail — o conjunto de imagens renderizado difere do pinado." >&2
  echo "  esperado:" >&2; printf '    %s\n' $ESPERADAS >&2
  echo "  renderizado:" >&2; printf '    %s\n' $ENCONTRADAS >&2
  exit 1
fi
echo "  ✓ guard_render: o chart resolve exatamente o conjunto pinado ($(printf '%s\n' "$ESPERADAS" | wc -l) imagem/ns)"

# O GIT_SHA tem de ter chegado ao render tambem — e a chave que as lanes de
# promocao leem de volta da branch de origem para medir frescor. Se ela ficar
# vazia (ou divergente), o guard de frescor nunca reprova nada e vira decoracao.
# Le o valor da variavel GIT_SHA especificamente (a linha logo apos `name:
# GIT_SHA`) — nao qualquer `value:` com 40 hex, que um dia casaria um id opaco de
# configuracao e faria o guard concordar consigo mesmo por acidente.
GIT_SHA_RENDER="$(awk '/^[[:space:]]*-[[:space:]]*name:[[:space:]]*GIT_SHA[[:space:]]*$/ { pega = 1; next }
                       pega { gsub(/"/, "", $2); print $2; pega = 0 }' "${TMP}/render.yaml" | sort -u)"
[ "$GIT_SHA_RENDER" = "$SHA" ] \
  || erro "guard_render=fail — GIT_SHA renderizado ('${GIT_SHA_RENDER}') difere do git-sha pinado ('${SHA}')"
echo "  ✓ guard_render: GIT_SHA=${SHA} chega a todos os workloads"

# ── commita ─────────────────────────────────────────────────────────────────
if git diff --quiet -- "$VALUES"; then
  PIN_SHA="$(git rev-parse HEAD)"
  echo "  = ${VALUES} ja estava neste bloco de pins — nada a commitar"
  echo "  pin_sha=${PIN_SHA} (HEAD atual; e a revisao que o Argo vai sincronizar)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "pin_sha=${PIN_SHA}" >> "$GITHUB_OUTPUT"; fi
  exit 0
fi

git config user.name  "khal-release-bot"
git config user.email "khal-release-bot@namastex.ai"
# `git add` do arquivo unico, nao `-A`: o commit de pin PRECISA tocar so o values
# do ambiente, senao o `paths-ignore` do workflow nao vale e a lane se re-chama.
git add -- "$VALUES"
RESUMO="$(jq -r '[to_entries[] | "\(.key)@\(.value[7:19])"] | join(" ")' <<<"$BLOCO")"
git commit -q -m "chore(gitops): pin ${AMBIENTE} — ${RESUMO} (src ${SHA})"

BRANCH="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

if [ "${GITOPS_PIN_SKIP_PUSH:-0}" = "1" ]; then
  PIN_SHA="$(git rev-parse HEAD)"
  echo "  · GITOPS_PIN_SKIP_PUSH=1 — commit local ${PIN_SHA}, sem push (modo de teste)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "pin_sha=${PIN_SHA}" >> "$GITHUB_OUTPUT"; fi
  exit 0
fi

# Rebase e retry: duas lanes podem terminar juntas, e perder o deploy para um
# push concorrente e falha que ninguem investiga — o log so diz "rejected".
for tentativa in 1 2 3; do
  if git push origin "HEAD:${BRANCH}"; then
    PIN_SHA="$(git rev-parse HEAD)"
    echo "  ✓ pin commitado e empurrado em ${BRANCH} (tentativa ${tentativa}) — commit ${PIN_SHA}"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "pin_sha=${PIN_SHA}" >> "$GITHUB_OUTPUT"; fi
    exit 0
  fi
  echo "  · push rejeitado (tentativa ${tentativa}) — rebase em cima de origin/${BRANCH}"
  git fetch --no-tags origin "$BRANCH"
  git pull --rebase --autostash origin "$BRANCH" || { git rebase --abort || true; }
done

erro "o push do pin falhou apos 3 tentativas — NADA foi para o cluster"
