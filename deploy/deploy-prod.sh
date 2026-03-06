#!/bin/bash
set -e
echo "=== Deploying to PROD (main) ==="
cd /home/brian/grimdm
git pull origin main
systemctl --user restart grimdm
sleep 2
systemctl --user is-active grimdm
echo "✅ grimdm.scrappylabs.ai updated"
