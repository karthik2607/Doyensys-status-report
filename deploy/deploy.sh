#!/usr/bin/env bash
# Runs ON THE SERVER. Called by GitHub Actions after every push to main,
# or manually:  bash /opt/doyensys-portal/deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/doyensys-portal}"
BRANCH="${BRANCH:-main}"
PM2_NAME="${PM2_NAME:-doyensys-backend}"
# Optional: folder Nginx serves the frontend HTML from (leave empty to skip)
FRONTEND_DIR="${FRONTEND_DIR:-}"

cd "$APP_DIR"
echo "==> Pulling latest $BRANCH"
git fetch --prune origin
git reset --hard "origin/$BRANCH"

cd "$APP_DIR/backend"
if [ ! -f .env ]; then
  echo "ERROR: $APP_DIR/backend/.env is missing (it is not stored in git)." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci

echo "==> Prisma generate"
npx prisma generate

if [ -d prisma/migrations ]; then
  echo "==> Applying database migrations"
  npx prisma migrate deploy
fi

echo "==> Building"
npm run build

echo "==> Restarting backend"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start npm --name "$PM2_NAME" -- start
fi
pm2 save

if [ -n "$FRONTEND_DIR" ]; then
  echo "==> Publishing frontend to $FRONTEND_DIR"
  cp "$APP_DIR/frontend/doyensys-portal-live.html" "$FRONTEND_DIR/index.html"
fi

echo "==> Health check"
sleep 3
curl -fsS "http://localhost:${PORT:-4000}/health" && echo && echo "Deploy OK"
