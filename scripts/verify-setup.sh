#!/usr/bin/env bash
set -euo pipefail

echo "========================================"
echo "CaptureLock Environment Verification"
echo "========================================"

# Node version check
NODE_VERSION=$(node -v)
echo "[✓] Node.js version: $NODE_VERSION"

# pnpm version check
PNPM_VERSION=$(pnpm -v)
echo "[✓] pnpm version: $PNPM_VERSION"

# Docker check
if command -v docker >/dev/null 2>&1; then
  DOCKER_VERSION=$(docker --version)
  echo "[✓] Docker version: $DOCKER_VERSION"
else
  echo "[!] Docker not detected (optional for unit tests, required for local postgres)"
fi

# Secrets check (.env must not be committed)
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[CRITICAL ERROR] .env file is tracked by git!"
  exit 1
else
  echo "[✓] .env is not tracked by git"
fi

echo "========================================"
echo "Environment verification complete."
echo "========================================"
