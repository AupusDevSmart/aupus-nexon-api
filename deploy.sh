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

step "Verificando working tree limpo"
if [ -n "$(git status --porcelain)" ]; then
  echo "Mudancas locais nao commitadas detectadas:"
  git status --short
  err "Resolva (commit/stash/discard) antes de fazer deploy. Veja docs/PRE-DEPLOY.md."
fi

step "git pull --ff-only origin main"
git pull --ff-only origin main

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

step "Gerando Prisma Client"
pnpm prisma generate

step "Snapshot de dist/ anterior em dist.previous/"
rm -rf dist.previous
[ -d dist ] && cp -a dist dist.previous || true

step "Build (nest build)"
pnpm run build

step "Garantindo logs/"
mkdir -p logs

step "Reload no PM2 ($PM2_APP)"
pm2 reload ecosystem.config.cjs --update-env

step "Estado final"
pm2 list | grep -E "name|$PM2_APP" || true

printf '\nDeploy concluido. Para rollback: rm -rf dist && mv dist.previous dist && pm2 reload ecosystem.config.cjs\n'
