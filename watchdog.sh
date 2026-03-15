#!/usr/bin/env bash
# GrimDM Watchdog — checks health, restarts if down, alerts Brian
set -euo pipefail

URL="http://localhost:8080/health"
SERVICE="grimdm.service"
NTFY_TOPIC="fleet-sentinel-moya"

check() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null || echo "000")
    echo "$status"
}

STATUS=$(check)

if [ "$STATUS" != "200" ]; then
    echo "[$(date)] GrimDM DOWN (HTTP $STATUS) — restarting..."
    systemctl --user restart "$SERVICE"
    sleep 3
    STATUS2=$(check)
    if [ "$STATUS2" = "200" ]; then
        curl -s -o /dev/null -d "GrimDM was down (HTTP $STATUS), auto-restarted successfully" \
            -H "Title: GrimDM Auto-Restart" \
            -H "Priority: high" \
            -H "Tags: warning" \
            "https://ntfy.sh/$NTFY_TOPIC"
        echo "[$(date)] GrimDM recovered after restart"
    else
        curl -s -o /dev/null -d "GrimDM is DOWN and restart FAILED (HTTP $STATUS2). Manual intervention needed!" \
            -H "Title: GrimDM DOWN" \
            -H "Priority: urgent" \
            -H "Tags: skull" \
            "https://ntfy.sh/$NTFY_TOPIC"
        echo "[$(date)] GrimDM STILL DOWN after restart (HTTP $STATUS2)"
    fi
fi
