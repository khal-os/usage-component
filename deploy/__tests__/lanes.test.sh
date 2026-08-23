#!/usr/bin/env bash
# TESTE DE CONTRATO DAS LANES — o que os quatro workflows novos tem de garantir,
# verificado no ARQUIVO. Um workflow so e exercitado quando roda de verdade, e
# quando ele roda de verdade ja mexeu no registry; estas asserces sao o que da
# para provar antes disso.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$RAIZ"

WF=".github/workflows"
CI="${WF}/eks-ci.yml"
DEV="${WF}/eks-deploy-dev.yml"
HML="${WF}/eks-deploy-homolog.yml"
MAIN="${WF}/eks-deploy-main.yml"
ROLE="arn:aws:iam::278522730053:role/gha-kos-usage-component-ecr-push"

titulo "os quatro arquivos existem"
for f in "$CI" "$DEV" "$HML" "$MAIN"; do
  [ -f "$f" ] && ok "existe ${f}" || falha "falta ${f}"
done

titulo "toda action e pinada por SHA de 40 hex"
# Tag de action e mutavel: `@v4` hoje e um commit, amanha e outro, e a esteira
# inteira roda codigo de terceiro que ninguem revisou.
MAS=""
for f in "$CI" "$DEV" "$HML" "$MAIN"; do
  while read -r linha; do
    [ -z "$linha" ] && continue
    ref="${linha##*@}"
    [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || MAS="${MAS}${f}:${linha} "
  done <<<"$(grep -hoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+' "$f" | sed 's/^uses: //')"
done
verifica "nenhuma action por tag" "" "$MAS"

titulo "gates de publicacao"
for f in "$DEV" "$HML" "$MAIN"; do
  contem "$(basename "$f"): gate KOS_EKS_PUBLISH_ENABLED" "vars.KOS_EKS_PUBLISH_ENABLED == 'true'" "$(cat "$f")"
done
contem "main: gate extra KOS_EKS_PROD_ENABLED" "vars.KOS_EKS_PROD_ENABLED == 'true'" "$(cat "$MAIN")"
contem "main: environment prod-eks"            "environment: prod-eks"                "$(cat "$MAIN")"
nao_contem "dev nao declara environment de prod"     "environment: prod-eks" "$(cat "$DEV")"
nao_contem "homolog nao declara environment de prod" "environment: prod-eks" "$(cat "$HML")"

titulo "anti-laco: cada lane ignora SO o proprio values"
contem "dev ignora values-dev"          "- 'deploy/values-dev.yaml'"  "$(cat "$DEV")"
contem "homolog ignora values-hml"      "- 'deploy/values-hml.yaml'"  "$(cat "$HML")"
contem "main ignora values-prod"        "- 'deploy/values-prod.yaml'" "$(cat "$MAIN")"
for f in "$DEV" "$HML" "$MAIN"; do
  nao_contem "$(basename "$f"): sem padrao largo values-*" "deploy/values-*.yaml'" "$(grep -A4 'paths-ignore:' "$f")"
done

titulo "so a lane dev builda"
contem "dev builda"            "docker/build-push-action" "$(cat "$DEV")"
nao_contem "homolog NAO builda" "build-push-action"        "$(cat "$HML")"
nao_contem "main NAO builda"    "build-push-action"        "$(cat "$MAIN")"

titulo "promocao le o ARQUIVO da origem, nunca a topologia do merge"
for f in "$HML" "$MAIN"; do
  # A prosa do cabecalho EXPLICA por que HEAD^2 esta errado; o que nao pode
  # existir e HEAD^2 em codigo. Por isso a busca ignora linhas de comentario.
  nao_contem "$(basename "$f"): sem HEAD^2 fora de comentario" 'HEAD^2' "$(grep -v '^[[:space:]]*#' "$f")"
  contem "$(basename "$f"): le por git archive da origem" 'git archive "origin/${SRC_BRANCH}" deploy' "$(cat "$f")"
done
contem "homolog promove de eks/dev"     "SRC_BRANCH: eks/dev"     "$(cat "$HML")"
contem "main promove de eks/homolog"    "SRC_BRANCH: eks/homolog" "$(cat "$MAIN")"

titulo "guards da promocao (a..e)"
for f in "$HML" "$MAIN"; do
  n="$(basename "$f")"
  contem "${n}: guard de formato do digest" "guard_digest=fail" "$(cat "$f")"
  contem "${n}: guard de repositorio"       "guard_repo=fail"   "$(cat "$f")"
  contem "${n}: guard de frescor"           "guard_frescor=fail" "$(cat "$f")"
  contem "${n}: guard de render do destino" "guard_render_destino=fail" "$(cat "$f")"
  contem "${n}: probe autenticado no ECR"   "guard_registry=fail" "$(cat "$f")"
  contem "${n}: retag conferido"            "retag=fail"        "$(cat "$f")"
  contem "${n}: evidencia no step summary"  "GITHUB_STEP_SUMMARY" "$(cat "$f")"
  contem "${n}: retag ANTES do pin"         "Probe autenticado + retag" "$(cat "$f")"
done

titulo "HOLD e lido ANTES de qualquer mutacao externa (CONTRATO §6)"
# O gitops-pin.sh tambem checa o HOLD, mas ele roda no fim: na lane dev depois do
# push da imagem, nas de promocao depois do retag. Como o ECR e IMMUTABLE, uma
# tag publicada durante um freeze nao se desfaz — o freeze tem de ser a PRIMEIRA
# coisa que a lane le.
linha_de() { grep -n -m1 -- "$2" "$1" | cut -d: -f1; }
for f in "$DEV" "$HML" "$MAIN"; do
  n="$(basename "$f")"
  contem "${n}: checa HOLD" "HOLD ativo? (freeze declarado no repo)" "$(cat "$f")"
  L_HOLD="$(linha_de "$f" 'name: HOLD ativo?')"
  # A primeira mutacao externa possivel de cada lane: assumir a role de OIDC ja
  # e o passo que da poder de escrever no registry.
  L_MUT="$(linha_de "$f" 'uses: aws-actions/configure-aws-credentials')"
  if [ -n "$L_HOLD" ] && [ -n "$L_MUT" ] && [ "$L_HOLD" -lt "$L_MUT" ]; then
    ok "${n}: HOLD (linha ${L_HOLD}) vem antes do OIDC/ECR (linha ${L_MUT})"
  else
    falha "${n}: HOLD em '${L_HOLD:-<ausente>}' nao precede a mutacao externa em '${L_MUT:-<ausente>}'"
  fi
done
# Na lane dev o passo mora no job `resolver`, do qual `build` depende — e por
# isso que ele precede tambem o build-push-action, que esta em outro job.
contem "dev: o job de build depende do job que le o HOLD" "needs: resolver" "$(cat "$DEV")"

titulo "coordenadas de infraestrutura"
for f in "$DEV" "$HML" "$MAIN"; do
  contem "$(basename "$f"): role de OIDC do contrato" "$ROLE" "$(cat "$f")"
  contem "$(basename "$f"): registry 278 (core-services-prod)" "278522730053.dkr.ecr.sa-east-1.amazonaws.com" "$(cat "$f")"
  contem "$(basename "$f"): concurrency serializa a lane" "concurrency:" "$(cat "$f")"
done
contem "dev -> hv-kos-components-dev"   "ARGOCD_APP: hv-kos-components-dev"  "$(cat "$DEV")"
contem "hml -> hv-kos-components-hml"   "ARGOCD_APP: hv-kos-components-hml"  "$(cat "$HML")"
contem "prod -> hv-kos-components-prod" "ARGOCD_APP: hv-kos-components-prod" "$(cat "$MAIN")"

titulo "o gate do Argo roda em modo real, sem skip"
for f in "$DEV" "$HML" "$MAIN"; do
  n="$(basename "$f")"
  contem "${n}: chama verify-argo.sh"        "deploy/verify-argo.sh"            "$(cat "$f")"
  contem "${n}: exige medida real"           "ARGOCD_VERIFY_REQUIRE_LIVE: '1'"  "$(cat "$f")"
  contem "${n}: deadline de 900s"            "ARGOCD_VERIFY_DEADLINE_SECONDS: '900'" "$(cat "$f")"
  contem "${n}: prefixo de imagem esperado"  "EXPECTED_IMAGE_PREFIX"            "$(cat "$f")"
done

titulo "permissoes minimas"
contem "dev: pin com contents write" "contents: write" "$(cat "$DEV")"
contem "dev: OIDC so no job de build" "id-token: write" "$(cat "$DEV")"
contem "ci: somente leitura"          "contents: read"  "$(cat "$CI")"
nao_contem "ci nao escreve no repo"   "contents: write" "$(cat "$CI")"

titulo "eks-ci nao sequestra a esteira ECS que roda hoje"
# `paths: deploy/**` no gatilho de pull_request colocaria este check — e com ele
# o guard do §0.1 logo abaixo — em cima de todo PR de manutencao da esteira ECS
# (deploy/taskdefs, deploy/scripts/deploy-tenant.sh, deploy/tenants), que e a que
# serve producao ate o cutover. Vermelho impossivel de satisfazer nao e gate: e
# ruido que ensina o time a ignorar check vermelho.
GATILHO_PR="$(awk '/^  pull_request:/{p=1; next} p&&/^  [a-z_]+:/{exit} p' "$CI")"
nao_contem "eks-ci nao observa deploy/** inteiro" "- 'deploy/**'" "$GATILHO_PR"
for caminho in "- 'deploy/chart/**'" "- 'deploy/values-*.yaml'" "- 'deploy/__tests__/**'" "- '.github/workflows/eks-*.yml'"; do
  contem "eks-ci observa ${caminho}" "$caminho" "$GATILHO_PR"
done

titulo "CONTRATO §0.1 — nada da esteira atual foi tocado"
BASE="${KOS_BASE_REF:-origin/main}"
# O guard compara a arvore INTEIRA contra main e exige que tudo desta stream
# seja arquivo NOVO. Isso so significa alguma coisa quando o que esta sendo
# medido E esta stream — ou seja, nas branches `eks/**`. Num PR da esteira ECS o
# mesmo diff acusaria como "modificado" um arquivo que esta stream nunca tocou.
# Fora de eks/** o guard nao aprova nada: ele diz, em voz alta, que NAO mediu.
REF="${KOS_REF_NAME:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}}}"
if [[ "$REF" != eks/* ]]; then
  ok "NAO MEDIDO nesta ref ('${REF:-<desconhecida>}' nao e eks/**) — o guard do §0.1 mede as branches da stream; a esteira ECS tem os proprios checks"
else
  if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
    git fetch --no-tags --quiet origin main 2>/dev/null || true
  fi
  if git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
    TOCADOS="$(git diff --name-status "$BASE" -- . | awk '$1 != "A" { print $1 " " $2 }')"
    verifica "nenhum arquivo pre-existente modificado ou removido" "" "$TOCADOS"
  else
    falha "nao consegui resolver ${BASE} — este guard NAO foi medido (defina KOS_BASE_REF ou traga a base)"
  fi
fi

encerra "lanes"
