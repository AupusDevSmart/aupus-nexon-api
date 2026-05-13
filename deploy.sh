#!/usr/bin/env bash
# deploy.sh - aupus-nexon-api
# Uso: ./deploy.sh    (rodar a partir da raiz do projeto)
# Pre-condicoes:
#   - working tree limpo (git status sem mudancas)
#   - branch alinhado com origin/main
#   - .env populado (com CORS_ORIGIN, JWT_SECRET, DATABASE_URL etc.)
#   - PM2 ja inicializado uma vez via ecosystem.config.cjs
set -euo pipefail

PROJECT_NAME="aupus-nexon-api"
PM2_APP="aupus-nexon-api"

step() { printf '\n>>> %s\n' "$*"; }
err()  { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"

# SELF_REEXEC: faz git pull antes e re-executa o script com a versao nova.
# Sem isso, se o proprio deploy.sh muda no commit puxado, bash le metade
# do arquivo antigo + metade do novo de forma inconsistente (bug observado
# em 2026-04-29 no firmware-compiler). Pull foge pra ca, restante do script
# fica logo abaixo do guard.
if [ "${SELF_REEXEC:-}" != "1" ]; then
  step "Verificando working tree limpo"
  if [ -n "$(git status --porcelain)" ]; then
    echo "Mudancas locais nao commitadas detectadas:"
    git status --short
    err "Resolva (commit/stash/discard) antes de fazer deploy. Veja docs/PRE-DEPLOY.md."
  fi

  step "git pull --ff-only origin main"
  git pull --ff-only origin main

  export SELF_REEXEC=1
  # exec bash explicito: quando invocado como `bash deploy.sh` (sem ./)
  # o $0 e' so "deploy.sh" e exec "$0" procuraria no PATH. Passando como
  # argumento pro bash, ele resolve via CWD (que ja eh o dirname do script).
  exec bash "$0" "$@"
fi

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

# pnpm v10 strict ignora o postinstall do @prisma/client. Como o schema
# vem do @aupus/api-shared, e bumps dessa dep podem trazer schema novo,
# precisa gerar o Client explicitamente apontando pro schema dele.
# (ref: memory reference_pnpm10_prisma_generate.md)
step "pnpm prisma generate"
pnpm prisma generate --schema=node_modules/@aupus/api-shared/prisma/schema.prisma

step "Snapshot de dist/ anterior em dist.previous/"
rm -rf dist.previous
[ -d dist ] && cp -a dist dist.previous || true

step "Build (nest build)"
pnpm run build

step "Garantindo logs/"
mkdir -p logs

step "Reload no PM2 ($PM2_APP)"
pm2 reload ecosystem.config.cjs --update-env

# ---- firmware-compiler (subdir) ----
# Subprojeto Node plano (sem deps npm hoje), porem mantemos pnpm install para
# garantir node_modules/ caso deps sejam adicionadas. Idempotente.
if [ -d firmware-compiler ]; then
  step "firmware-compiler: pnpm install"
  (cd firmware-compiler && pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod)

  step "firmware-compiler: garantindo artifacts/"
  mkdir -p firmware-compiler/artifacts

  step "firmware-compiler: startOrReload PM2"
  pm2 startOrReload firmware-compiler/ecosystem.config.cjs --update-env
fi

step "Estado final"
pm2 list | grep -E "name|$PM2_APP|aupus-firmware-compiler" || true

printf '\nDeploy concluido. Para rollback: rm -rf dist && mv dist.previous dist && pm2 reload ecosystem.config.cjs\n'
