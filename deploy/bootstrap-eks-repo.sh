#!/usr/bin/env bash
# Bootstrap do repo no GitHub para a esteira EKS (Actions -> ECR 278 -> Argo CD).
#
# Por que existe: nao ha terraform gerenciando repo do GitHub em lugar nenhum da
# frota. Com uma dezena de repos vindo, clique nao escala — e o que nao escala
# nao e o cadastro em si, e LEMBRAR dos cinco itens.
#
# O que ele FAZ (idempotente, DRY-RUN por padrao):
#   1. cria as branches de teste eks/dev, eks/homolog, eks/main a partir de main;
#   2. cria as Variables de gate KOS_EKS_PUBLISH_ENABLED / KOS_EKS_PROD_ENABLED;
#   3. cria o Environment `prod-eks` com required reviewers e branch policy;
#   4. audita o secret ARGOCD_CI_TOKEN e explica o efeito da ausencia.
#
# O que ele NAO faz, de proposito:
#   · NAO grava o secret ARGOCD_CI_TOKEN. Segredo entra por stdin (`gh secret
#     set`), nunca por argv — argv vaza em `ps`, no historico do shell e no log.
#   · NAO liga os gates fora de `--arm`. Ligar o publish ARMA a esteira: o
#     proximo push em eks/dev builda e empurra para o ECR. Se o repositorio ECR,
#     a role de OIDC ou a Application do Argo ainda nao existirem, a lane falha
#     DEPOIS de ja ter mexido em coisa real.
#   · NAO cria branch protection nem ruleset (decisao de quem opera o repo, e o
#     cutover ainda nao aconteceu).
#   · NAO toca em NADA da esteira atual (build-images.yml, deploy-tenant.yml,
#     ci.yml, deploy/taskdefs/) — este repo continua entregando em ECS ate o
#     cutover.
#
# Uso:
#   deploy/bootstrap-eks-repo.sh <owner/repo> [--reviewers a,b] [--arm] [--apply]
#     (sem --apply so imprime o que faria)
set -Eeuo pipefail

REPO="${1:-}"; shift || true
REVIEWERS=""; APPLY=0; ARM=0; BASE="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --reviewers) REVIEWERS="${2:-}"; shift 2 ;;
    --base)      BASE="${2:-main}"; shift 2 ;;
    --apply)     APPLY=1; shift ;;
    --arm)       ARM=1; shift ;;
    -h|--help)   sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "uso: $0 <owner/repo> [--reviewers a,b] [--base main] [--arm] [--apply]" >&2; exit 2; }

# Nomes FIXOS, nao derivados do repo: as duas Variables sao do PROGRAMA kos e
# tem de casar entre khal-platform e usage-component — duas lanes lendo nomes
# diferentes e o jeito mais silencioso de armar meio programa.
V_PUBLISH="KOS_EKS_PUBLISH_ENABLED"
V_PROD="KOS_EKS_PROD_ENABLED"
ENVIRONMENT="prod-eks"
BRANCHES=(eks/dev eks/homolog eks/main)

command -v gh >/dev/null || { echo "gh nao encontrado" >&2; exit 1; }

run()  { if [ "$APPLY" = 1 ]; then "$@"; else printf '   [dry-run] %s\n' "$*"; fi; }
ok()   { printf '  ok    %s\n' "$*"; }
todo() { printf '  falta %s\n' "$*"; }

echo "repo: $REPO   base: $BASE   environment: $ENVIRONMENT"
gh api "repos/$REPO" >/dev/null 2>&1 || { echo "nao consigo ler $REPO — confira 'gh auth status'" >&2; exit 1; }
gh api "repos/$REPO" --jq '"  visibilidade: \(.visibility)   default: \(.default_branch)"'

echo
echo "== Branches de teste =="
BASE_SHA="$(gh api "repos/$REPO/git/ref/heads/$BASE" --jq .object.sha 2>/dev/null || true)"
[ -n "$BASE_SHA" ] || { echo "branch base '$BASE' nao existe em $REPO" >&2; exit 1; }
for b in "${BRANCHES[@]}"; do
  if gh api "repos/$REPO/git/ref/heads/$b" >/dev/null 2>&1; then
    ok "$b existe (NAO e movida por este script — mover branch de ambiente e deploy, nao bootstrap)"
  else
    run gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/heads/$b" -f "sha=$BASE_SHA"
    todo "$b ausente -> criar a partir de $BASE ($BASE_SHA)"
  fi
done

echo
echo "== Variables de gate =="
for V in "$V_PUBLISH" "$V_PROD"; do
  # `gh api` escreve o corpo do erro no STDOUT em 404; sem separar exit de saida,
  # o JSON de "Not Found" viraria o valor atual da variavel.
  if ! atual="$(gh api "repos/$REPO/actions/variables/$V" --jq .value 2>/dev/null)"; then atual=""; fi
  desejado="false"; [ "$ARM" = 1 ] && desejado="true"
  if [ -z "$atual" ]; then
    run gh variable set "$V" -R "$REPO" --body "$desejado"
    todo "$V ausente -> criar com '$desejado'"
  elif [ "$atual" = "$desejado" ]; then
    ok "$V = $atual"
  else
    run gh variable set "$V" -R "$REPO" --body "$desejado"
    todo "$V = $atual -> $desejado"
  fi
done
[ "$ARM" = 1 ] || echo "   (sem --arm as duas nascem 'false': o repo fica pronto e a esteira DESARMADA)"

echo
echo "== Environment $ENVIRONMENT =="
if gh api "repos/$REPO/environments/$ENVIRONMENT" >/dev/null 2>&1; then
  revs="$(gh api "repos/$REPO/environments/$ENVIRONMENT" \
        --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?.reviewer.login] | join(",")' 2>/dev/null || true)"
  [ -n "$revs" ] && ok "$ENVIRONMENT existe, reviewers: $revs" \
                 || todo "$ENVIRONMENT existe SEM required reviewers — o job de prod roda sem aprovacao"
else
  if [ -n "$REVIEWERS" ]; then
    args=(); IFS=','; for u in $REVIEWERS; do
      id="$(gh api "users/$u" --jq .id 2>/dev/null)" || { echo "usuario desconhecido: $u" >&2; exit 1; }
      args+=(-f 'reviewers[][type]=User' -F "reviewers[][id]=$id")
    done; unset IFS
    run gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" \
      -F 'deployment_branch_policy[protected_branches]=false' \
      -F 'deployment_branch_policy[custom_branch_policies]=true' "${args[@]}"
    todo "$ENVIRONMENT ausente -> criar com reviewers $REVIEWERS"
    echo "   depois: cadastrar a branch policy custom para 'eks/main' (e 'main' no cutover)"
  else
    todo "$ENVIRONMENT ausente e --reviewers nao informado (nao invento aprovador)"
  fi
fi
echo "   O Environment tambem e o que sustenta o trust do OIDC de prod, se um dia a role"
echo "   passar a exigir 'repo:<org>/<repo>:environment:$ENVIRONMENT': o GitHub so emite esse"
echo "   sub para job que DECLARA o environment — que e o que dispara a aprovacao. Hoje o"
echo "   trust da role gha-kos-usage-component-ecr-push aceita 'repo:khal-os/usage-component:*'."

echo
echo "== Secret do gate de verify =="
if gh api "repos/$REPO/actions/secrets/ARGOCD_CI_TOKEN" >/dev/null 2>&1; then
  ok "ARGOCD_CI_TOKEN cadastrado"
else
  todo "ARGOCD_CI_TOKEN ausente — o gate fica VERMELHO (nao pula; foi de proposito)"
  echo "   gere no Argo e cole por stdin, sem passar por arquivo nem por argv:"
  echo "     argocd account generate-token --account ci-kos-verify --expires-in 90d"
  echo "     gh secret set ARGOCD_CI_TOKEN -R $REPO"
fi

echo
echo "== Fora do GitHub (precisa existir ANTES de --arm) =="
echo "   · ECR 278522730053: kos/usage-module, kos/usage-connector, kos/usage-db-backup"
echo "     (IMMUTABLE, scanOnPush, repository policy de pull para 701016785827 e 652197205677)"
echo "   · role OIDC arn:aws:iam::278522730053:role/gha-kos-usage-component-ecr-push"
echo "   · Applications hv-kos-components-{dev,hml,prod} no Argo + AppProject kos-hapvida aplicado"
echo "   · conta ci-kos-verify no argocd-cm + bind read-only no argocd-rbac-cm"
echo
[ "$APPLY" = 1 ] || echo "nada foi escrito. repita com --apply para aplicar."
