#!/usr/bin/env bash
# Deploy GrimDM to Google Cloud Run
# Requires: gcloud CLI authenticated, project APIs enabled
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-scrappylabs}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
SERVICE="grimdm"

echo "=== GrimDM Cloud Run Deploy ==="
echo "  Project: $PROJECT"
echo "  Region:  $REGION"
echo "  Service: $SERVICE"
echo ""

cd "$(dirname "$0")/../backend"

# Ensure Secret Manager has our API key
# First-time setup: gcloud secrets create GEMINI_API_KEY --data-file=- <<< "your-key"
echo "Deploying from $(pwd)..."

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --port 8080 \
  --allow-unauthenticated \
  --session-affinity \
  --timeout 3600 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5 \
  --concurrency 10 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,SL_API_URL=https://api.scrappylabs.ai" \
  --set-secrets "GOOGLE_API_KEY=GEMINI_API_KEY:latest"

echo ""
echo "=== Deployed! ==="
URL=$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format "value(status.url)")
echo "URL: $URL"
echo ""
echo "Test: curl $URL/health"
