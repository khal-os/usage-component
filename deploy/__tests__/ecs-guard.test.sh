#!/usr/bin/env bash
# ECS GUARD FIXTURES — the CONTRATO §0.1 guard (_ecs-guard.sh) measured on a
# throwaway repo whose history is built on purpose, in the shape the real lanes
# have: main ships a fix to the ECS pipeline, eks/dev takes it by a real merge,
# and eks/homolog receives eks/dev as ONE squash commit (the repo only allows
# squash merges). The squashed lane must pass; a file the eks side really
# changed must still fail.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_ecs-guard.sh"

command -v git >/dev/null || { echo "FALTA: git"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
R="${WORK}/repo"

g() { git -C "$R" "$@"; }
# put <path> <content> — writes one file in the fixture work tree
put() { mkdir -p "$(dirname "${R}/$1")" && printf '%s\n' "$2" >"${R}/$1"; }
commit() { g add -A && g commit -q -m "$1"; }
# guard_on <branch> — the guard as lanes.test.sh runs it, with <branch> as HEAD
guard_on() { g checkout -q "$1" && (cd "$R" && ecs_touched main); }
# case_branch <name> — a new branch off the squashed lane, checked out
case_branch() { g checkout -q -b "$1" eks/homolog; }

# --- history ------------------------------------------------------------------
git init -q -b main "$R"
g config user.email t@t && g config user.name teste && g config commit.gpgsign false
put deploy/taskdefs/usage-module.json '{"image":"v1"}'
put deploy/tenants/hapvida.env 'TENANT=hapvida'
put deploy/scripts/deploy-tenant.sh 'echo deploy v1'
put deploy/langwatch/legacy.yaml 'legacy: true'
put .github/workflows/docker.yml 'trivy: v1'
put .github/workflows/eks-ci.yml 'ci: v1'
put deploy/chart/Chart.yaml 'version: 0.1.0'
commit "init"
g branch eks/dev && g branch eks/homolog

# main fixes the ECS pipeline: one M, one A, one D (the #69 shape)
put .github/workflows/docker.yml 'trivy: v2 (dated ignore)'
put deploy/tenants/new-client.env 'TENANT=new-client'
g rm -q deploy/langwatch/legacy.yaml
commit "fix(ci): dated trivyignore (#69)"
FIX="$(g rev-parse HEAD)"

# eks/dev works on its own tree and takes main by a real merge (ancestry kept)
g checkout -q eks/dev
put deploy/chart/Chart.yaml 'version: 0.2.0'
put .github/workflows/eks-ci.yml 'ci: v2'
commit "feat(chart): bump"
g merge -q --no-ff --no-edit main

# the promotion squashes eks/dev into eks/homolog: main's fix is now content only
g checkout -q eks/homolog
g merge -q --squash eks/dev >/dev/null
commit "chore(promote): eks/dev -> eks/homolog"

# main keeps evolving on its own after the promotion
g checkout -q main
put deploy/scripts/deploy-tenant.sh 'echo deploy v2'
commit "fix(ecs): deploy-tenant v2"

# --- assertions ---------------------------------------------------------------
titulo "the fixture reproduces the incident"
verifica "main's fix is NOT an ancestor of the squashed lane" "no" \
  "$(g merge-base --is-ancestor "$FIX" eks/homolog && echo yes || echo no)"
THREE_DOT="$(g diff --name-status --no-renames main...eks/homolog -- "${ECS_BLOCKLIST[@]}" | tr '\t' ' ')"
contem "three-dot alone flags main's M" "M .github/workflows/docker.yml" "$THREE_DOT"
contem "three-dot alone flags main's A" "A deploy/tenants/new-client.env" "$THREE_DOT"
contem "three-dot alone flags main's D" "D deploy/langwatch/legacy.yaml" "$THREE_DOT"
contem "three-dot sees the eks-* workflow change" "M .github/workflows/eks-ci.yml" "$THREE_DOT"
contem "two-dot alone would flag main's later, independent change" "deploy/scripts/deploy-tenant.sh" \
  "$(g diff --name-only main eks/homolog -- "${ECS_BLOCKLIST[@]}")"

titulo "(a) content identical to main after a squash promotion passes"
verifica "eks/dev (main merged, ancestry kept)" "" "$(guard_on eks/dev)"
verifica "eks/homolog (main's M/A/D squashed in, eks-* change ignored)" "" "$(guard_on eks/homolog)"

titulo "(b) a file the eks side really changed still fails"
case_branch modified
put deploy/taskdefs/usage-module.json '{"image":"eks-only"}'
commit "eks edits a taskdef"
verifica "modified taskdef is reported, the squashed files are not" \
  "M deploy/taskdefs/usage-module.json" "$(guard_on modified)"

case_branch squashed-then-edited
put .github/workflows/docker.yml 'trivy: v3 (eks-only)'
commit "eks edits the file main's fix had touched"
verifica "a squashed file edited again on the eks side is reported" \
  "M .github/workflows/docker.yml" "$(guard_on squashed-then-edited)"

case_branch added
put deploy/scripts/eks-helper.sh 'echo eks'
commit "eks adds a script"
verifica "a file added on the eks side is reported" \
  "A deploy/scripts/eks-helper.sh" "$(guard_on added)"

case_branch deleted
g rm -q deploy/tenants/hapvida.env
commit "eks deletes a tenant"
verifica "a file deleted on the eks side is reported" \
  "D deploy/tenants/hapvida.env" "$(guard_on deleted)"

titulo "no merge-base: the guard refuses to measure"
g checkout -q --orphan unrelated
g rm -rfq .
put README.md 'unrelated history'
commit "orphan"
if (cd "$R" && ecs_touched main) >/dev/null 2>&1; then
  falha "ecs_touched returned success without a merge-base"
else
  ok "ecs_touched fails when main...HEAD has no merge-base"
fi

encerra "ecs-guard"
