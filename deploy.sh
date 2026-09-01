#!/bin/bash
# Deploy manual do backend-arbtrader no servidor Hetzner Ubuntu.
# Uso: bash deploy.sh
set -euo pipefail

cd ~/backend-arbtrader

echo "==> Atualizando repositorio..."
git pull origin main 2>/dev/null || true

echo "==> docker pull (baixando imagem do GHCR...)"
docker pull ghcr.io/lucasmelloleao/backend-arbtrader:latest

echo "==> docker compose up"
docker compose up -d --remove-orphans

echo "==> Deploy concluido. Status dos containers:"
docker compose ps
