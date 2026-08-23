#!/usr/bin/env bash
# Roda a suite inteira da esteira EKS. E o mesmo comando que o CI executa —
# uma lista so, para o CI e a maquina do dev nunca divergirem sobre o que "os
# testes" significam.
#
#   uso: bash deploy/__tests__/run-all.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FALHAS=0
for t in services chart-contract gitops-pin verify-argo lanes; do
  printf '\n############ %s ############\n' "$t"
  bash "${DIR}/${t}.test.sh" || FALHAS=$((FALHAS + 1))
done

printf '\n============================================\n'
if [ "$FALHAS" -eq 0 ]; then
  echo "TODAS as suites passaram."
else
  echo "${FALHAS} suite(s) FALHARAM."
fi
exit "$FALHAS"
