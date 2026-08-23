#!/usr/bin/env bash
# A LISTA — de onde as lanes tiram O QUE construir.
#
#   deploy/services.sh images    JSON [{name, repository, dockerfile, context}]
#   deploy/services.sh matrix    {"include":[...]} pronto para `strategy.matrix`
#   deploy/services.sh workloads TSV: <workload>\t<kind>\t<imagem>\t<enabled>
#   deploy/services.sh repos     JSON {nome-da-imagem: repositorio}
#
# Por que existe: a matrix e sobre IMAGENS, nao sobre servicos. `api`,
# `billing-close-scheduler` e o Job `migrations` rodam o MESMO binario
# (usage-module); uma matrix sobre servicos construiria o mesmo commit tres
# vezes, publicaria tres digests diferentes (npm ci nao e bit-a-bit
# reprodutivel) e o guard de frescor das lanes de promocao continuaria verde
# enquanto "qual binario e o commit X" perdeu resposta unica.
#
# Fonte unica: deploy/values.yaml. Uma imagem nova entra no deploy criando UMA
# entrada em `images:` — nao editando quatro workflows.
#
# GUARD embutido (roda em toda invocacao): todo workload tem de referenciar uma
# imagem declarada em `images:`, e o `image.repository` do workload tem de ser
# IDENTICO ao de `images:`. Sem isso, um values que sobrescreva `repository`
# faria a lane construir num repositorio e o cluster puxar de outro — os dois
# verdes, o deploy mentindo.
set -Eeuo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="${KOS_VALUES_FILE:-${RAIZ}/deploy/values.yaml}"
COMANDO="${1:-images}"

erro() { echo "::error::services.sh: $*" >&2; exit 1; }

command -v python3 >/dev/null || erro "python3 nao encontrado"
python3 -c 'import yaml' 2>/dev/null \
  || erro "PyYAML nao encontrado. Instale com: python3 -m pip install --disable-pip-version-check 'pyyaml==6.0.2'"
[ -f "$VALUES" ] || erro "values nao encontrado: ${VALUES}"

python3 - "$VALUES" "$COMANDO" <<'PY'
import json, sys, yaml

arquivo, comando = sys.argv[1], sys.argv[2]
with open(arquivo) as fh:
    v = yaml.safe_load(fh) or {}

imagens = v.get("images") or {}
if not imagens:
    sys.exit("::error::services.sh: `images:` vazio em %s — sem isso a lane nao sabe o que construir" % arquivo)

# Coleta os workloads das tres familias (services / jobs / cronjobs) numa lista
# unica: para o guard de coerencia elas sao a mesma coisa (algo que roda uma
# imagem), e tratar cada uma num ramo separado e como o guard deixa de valer
# para a familia que alguem esqueceu.
workloads = []
for familia, kind in (("services", "Deployment"), ("jobs", "Job"), ("cronjobs", "CronJob")):
    for nome, spec in sorted((v.get(familia) or {}).items()):
        spec = spec or {}
        img = spec.get("image") or {}
        workloads.append({
            "workload": nome,
            "kind": kind,
            "image": img.get("name") or nome,
            "repository": img.get("repository"),
            "enabled": bool(spec.get("enabled")),
        })

problemas = []
for w in workloads:
    decl = imagens.get(w["image"])
    if decl is None:
        problemas.append(
            "workload '%s' referencia a imagem '%s', que nao esta em `images:` (declaradas: %s)"
            % (w["workload"], w["image"], ", ".join(sorted(imagens)))
        )
        continue
    if w["repository"] and w["repository"] != decl.get("repository"):
        problemas.append(
            "workload '%s': image.repository '%s' diverge de images.%s.repository '%s'"
            % (w["workload"], w["repository"], w["image"], decl.get("repository"))
        )
for nome, decl in sorted(imagens.items()):
    for chave in ("repository", "dockerfile", "context"):
        if not decl.get(chave):
            problemas.append("images.%s sem `%s`" % (nome, chave))
if problemas:
    for p in problemas:
        print("::error::services.sh: " + p, file=sys.stderr)
    sys.exit(1)

lista = [
    {
        "name": nome,
        "repository": decl["repository"],
        "dockerfile": decl["dockerfile"],
        "context": decl["context"],
    }
    for nome, decl in sorted(imagens.items())
]

if comando == "images":
    print(json.dumps(lista))
elif comando == "matrix":
    print(json.dumps({"include": lista}))
elif comando == "repos":
    print(json.dumps({i["name"]: i["repository"] for i in lista}, sort_keys=True))
elif comando == "workloads":
    for w in workloads:
        print("\t".join([w["workload"], w["kind"], w["image"], "true" if w["enabled"] else "false"]))
else:
    sys.exit("::error::services.sh: comando desconhecido '%s' (images|matrix|repos|workloads)" % comando)
PY
