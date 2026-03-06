#!/bin/bash
set -e
echo "=== Deploying to DEV ==="
cd /home/brian/grimdm-dev
git pull origin dev
# Sync .env from prod (shared config)
ln -sf /home/brian/grimdm/backend/app/.env /home/brian/grimdm-dev/backend/app/.env 2>/dev/null || true
systemctl --user restart grimdm-dev
sleep 2
systemctl --user is-active grimdm-dev
echo "✅ grimdm-dev.scrappylabs.ai updated"
