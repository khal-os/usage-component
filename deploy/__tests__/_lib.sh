# Harness minimo dos testes da esteira. Bash puro de proposito: bats seria mais
# uma dependencia para o runner instalar antes de poder provar qualquer coisa,
# e o que estes testes precisam e de tres funcoes.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASSOU=0
FALHOU=0

titulo() { printf '\n== %s ==\n' "$*"; }
ok()     { PASSOU=$((PASSOU + 1)); printf '  ok    %s\n' "$*"; }
falha()  { FALHOU=$((FALHOU + 1)); printf '  FALHA %s\n' "$*"; }

# verifica <descricao> <esperado> <observado>
verifica() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    falha "$1"
    printf '        esperado: %s\n        observado: %s\n' "$2" "$3"
  fi
}

# contem <descricao> <agulha> <palheiro>
contem() {
  if grep -Fq -- "$2" <<<"$3"; then ok "$1"; else falha "$1 (nao achei '$2')"; fi
}

# nao_contem <descricao> <agulha> <palheiro>
nao_contem() {
  if grep -Fq -- "$2" <<<"$3"; then falha "$1 (achei '$2', e nao deveria)"; else ok "$1"; fi
}

encerra() {
  printf '\n-- %s: %d ok, %d falha(s)\n' "${1:-testes}" "$PASSOU" "$FALHOU"
  [ "$FALHOU" -eq 0 ] || exit 1
}
