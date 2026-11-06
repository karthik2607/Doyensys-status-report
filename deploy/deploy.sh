#!/usr/bin/env bash
# Runs ON THE SERVER as the `doyensys` user. Called by GitHub Actions after
# every push to main, or manually:
#   sudo -iu doyensys bash /opt/doyensys/app/deploy/deploy.sh
set -euo pipefail

APP_DIR="/opt/doyensys/app"                 # git clone of this repo
FRONTEND_DIR="/opt/doyensys/public"         # served by python http.server :5000
SERVICE="doyensys-api"                      # systemd unit running the backend
BRANCH="main"
PORT="4000"

cd "$APP_DIR"
echo "==> Pulling latest $BRANCH"
git fetch --prune origin
git reset --hard "origin/$BRANCH"
echo "    now at $(git log -1 --format='%h %s')"

cd "$APP_DIR/backend"
if [ ! -f .env ]; then
  echo "ERROR: $APP_DIR/backend/.env is missing (it is not stored in git)." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci --no-audit --no-fund

echo "==> Prisma generate + migrate"
npx prisma generate
npx prisma migrate deploy                   # prisma reads DATABASE_URL from ./.env itself

echo "==> Building"
npm run build

echo "==> Restarting $SERVICE"
sudo /usr/bin/systemctl restart "$SERVICE"

echo "==> Publishing frontend"
cp "$APP_DIR/frontend/doyensys-portal-live.html" "$FRONTEND_DIR/index.html"

echo "==> Health check"
for i in $(seq 1 15); do
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "Deploy OK ($(git -C "$APP_DIR" log -1 --format=%h))"
    exit 0
  fi
  sleep 2
done
echo "ERROR: backend did not become healthy. Check: journalctl -u $SERVICE -n 100" >&2
exit 1
