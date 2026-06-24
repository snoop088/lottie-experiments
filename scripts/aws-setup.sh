#!/usr/bin/env bash
# Provision the AWS resources the app needs (AGENTS.md §14.4):
#   - DynamoDB table  : jobs (PK id, on-demand, TTL on `ttl` for draft cleanup)
#   - S3 bucket       : private (block all public access), CORS for browser
#                       presigned PUT/GET, lifecycle to expire staging/ uploads
#
# Idempotent — safe to re-run. Requires AWS creds in the environment (we load
# ./.env locally) and the AWS CLI.
#
# Usage:  set -a; . ./.env; set +a;  bash scripts/aws-setup.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
TABLE="${DYNAMODB_TABLE:-lottie-jobs}"
BUCKET="${S3_BUCKET:-lottie-render-${ACCOUNT}}"
# Browser origins allowed to PUT/GET via presigned URLs (add the custom domain later).
ORIGINS='["https://main.d2i1tmezpcq4dj.amplifyapp.com","http://localhost:3000"]'

echo "region=$REGION account=$ACCOUNT table=$TABLE bucket=$BUCKET"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# ---------- DynamoDB ----------
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "DynamoDB: table $TABLE already exists"
else
  echo "DynamoDB: creating $TABLE"
  aws dynamodb create-table \
    --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi
# TTL on `ttl` (epoch seconds) — auto-expire abandoned drafts.
aws dynamodb update-time-to-live --table-name "$TABLE" --region "$REGION" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null 2>&1 \
  && echo "DynamoDB: TTL enabled on 'ttl'" || echo "DynamoDB: TTL already set"

# ---------- S3 ----------
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "S3: bucket $BUCKET already exists"
else
  echo "S3: creating $BUCKET"
  # us-east-1 must NOT pass a LocationConstraint; every other region must.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi

echo "S3: blocking all public access"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

echo "S3: CORS (presigned PUT/GET from app origins)"
cat > "$tmp/cors.json" <<JSON
{ "CORSRules": [ {
  "AllowedHeaders": ["*"],
  "AllowedMethods": ["PUT","GET","HEAD"],
  "AllowedOrigins": $ORIGINS,
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
} ] }
JSON
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "file://$tmp/cors.json" >/dev/null

echo "S3: lifecycle (expire staging/ after 1 day)"
cat > "$tmp/lifecycle.json" <<'JSON'
{ "Rules": [ {
  "ID": "expire-staging",
  "Filter": { "Prefix": "staging/" },
  "Status": "Enabled",
  "Expiration": { "Days": 1 }
} ] }
JSON
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "file://$tmp/lifecycle.json" >/dev/null

# ---------- Amplify Basic Auth (shared-password gate, §14.8) ----------
# Hosting-level HTTP Basic Auth on the branch: blocks pages + API before the app
# runs. Driven from env so the password never lands in the repo or logs.
APP_ID="${AMPLIFY_APP_ID:-d2i1tmezpcq4dj}"
BRANCH="${AMPLIFY_BRANCH:-main}"
if [ -n "${BASIC_AUTH_USER:-}" ] && [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
  CREDS="$(printf '%s:%s' "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD" | base64 | tr -d '\n')"
  aws amplify update-branch --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" \
    --enable-basic-auth --basic-auth-credentials "$CREDS" >/dev/null
  echo "Amplify: Basic Auth ENABLED on branch $BRANCH (credentials from env)"
else
  echo "Amplify: Basic Auth skipped — set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD in .env, then re-run"
fi

echo ""
echo "Done. Set these in the app env (.env locally, Amplify env in prod):"
echo "  DYNAMODB_TABLE=$TABLE"
echo "  S3_BUCKET=$BUCKET"
echo "  AWS_REGION=$REGION"
