#!/usr/bin/env bash
# Deploy GrimDM to Google Cloud Run
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-scrappylabs}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
SERVICE="grimdm"

echo "Deploying GrimDM to Cloud Run..."
echo "  Project: $PROJECT"
echo "  Region:  $REGION"
echo "  Service: $SERVICE"

cd "$(dirname "$0")/../backend"

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --session-affinity \
  --timeout 3600 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT" \
  --set-secrets "GOOGLE_API_KEY=GEMINI_API_KEY:latest"

echo ""
echo "Deployed! Getting URL..."
gcloud run services describe "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format "value(status.url)"
