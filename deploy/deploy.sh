#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "[reel] Pulling latest from GitHub..."
cd "$REPO_DIR"
git pull

echo "[reel] Rebuilding and restarting container..."
cd "$SCRIPT_DIR"
docker compose down
docker compose up --build -d

echo "[reel] Deploy complete."
docker compose logs --tail=20
