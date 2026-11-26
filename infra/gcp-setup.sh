#!/usr/bin/env bash
# One-time Google Cloud setup for the Wallety API. Safe to run again: existing resources are kept.
#
# Usage (Cloud Shell, logged in as the project owner):
#   bash infra/gcp-setup.sh <PROJECT_ID>
#
# It creates no keys and reads no secrets. GitHub Actions authenticates through
# Workload Identity Federation, restricted to this repository's main branch.
set -euo pipefail

PROJECT_ID="${1:?usage: gcp-setup.sh <PROJECT_ID>}"
REGION="${REGION:-southamerica-east1}"
GITHUB_REPO="${GITHUB_REPO:-MatheusBorgesDev/wallety}"
SERVICE="wallety-api"
WORKER_SERVICE="wallety-worker"
REGISTRY="wallety"
DEPLOYER="wallety-deployer"
RUNTIME="wallety-api"
WORKER="wallety-worker"
POOL="github"
PROVIDER="wallety"
DB_SECRET="wallety-database-url"                      # runtime: a login that is a member of wallety_app
MIGRATION_DB_SECRET="wallety-migration-database-url"  # migrations: the database owner
DISPATCH_DB_SECRET="wallety-dispatch-database-url"    # delivery process: a member of wallety_dispatch
SIGNING_SECRET="wallety-webhook-signing-secret"       # generated below, never shown
JWT_SECRET="wallety-jwt-secret"                       # generated below, never shown

DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_EMAIL="${RUNTIME}@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_EMAIL="${WORKER}@${PROJECT_ID}.iam.gserviceaccount.com"

exists() { "$@" >/dev/null 2>&1; }

echo "==> Enabling APIs"
gcloud services enable --project="$PROJECT_ID" \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

echo "==> Artifact Registry repository"
exists gcloud artifacts repositories describe "$REGISTRY" --project="$PROJECT_ID" --location="$REGION" ||
  gcloud artifacts repositories create "$REGISTRY" --project="$PROJECT_ID" --location="$REGION" \
    --repository-format=docker --description="Wallety container images"

echo "==> Service accounts"
exists gcloud iam service-accounts describe "$DEPLOYER_EMAIL" --project="$PROJECT_ID" ||
  gcloud iam service-accounts create "$DEPLOYER" --project="$PROJECT_ID" --display-name="Wallety deploy (GitHub Actions)"
exists gcloud iam service-accounts describe "$RUNTIME_EMAIL" --project="$PROJECT_ID" ||
  gcloud iam service-accounts create "$RUNTIME" --project="$PROJECT_ID" --display-name="Wallety API runtime"
exists gcloud iam service-accounts describe "$WORKER_EMAIL" --project="$PROJECT_ID" ||
  gcloud iam service-accounts create "$WORKER" --project="$PROJECT_ID" --display-name="Wallety webhook delivery"

echo "==> Database URL secrets (empty containers; the values are added by hand in the console)"
for secret in "$DB_SECRET" "$MIGRATION_DB_SECRET" "$DISPATCH_DB_SECRET"; do
  exists gcloud secrets describe "$secret" --project="$PROJECT_ID" ||
    gcloud secrets create "$secret" --project="$PROJECT_ID" --replication-policy=automatic
done

echo "==> Webhook signing secret and access token secret (generated here; no one needs to see them)"
for secret in "$SIGNING_SECRET" "$JWT_SECRET"; do
  if ! exists gcloud secrets describe "$secret" --project="$PROJECT_ID"; then
    gcloud secrets create "$secret" --project="$PROJECT_ID" --replication-policy=automatic
    openssl rand -hex 32 | tr -d '\n' |
      gcloud secrets versions add "$secret" --project="$PROJECT_ID" --data-file=- >/dev/null
  fi
done

echo "==> Permissions"
grant_secret() { # <secret> <service account email>
  gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT_ID" \
    --role=roles/secretmanager.secretAccessor --member="serviceAccount:$2" --condition=None >/dev/null
}
# Each identity reads only the connection string it runs with. The deployer reads only the
# owner connection string, to apply migrations before each release.
grant_secret "$DB_SECRET" "$RUNTIME_EMAIL"
grant_secret "$DISPATCH_DB_SECRET" "$WORKER_EMAIL"
grant_secret "$MIGRATION_DB_SECRET" "$DEPLOYER_EMAIL"
# The API verifies webhook signatures (built-in receiver); the delivery process creates them.
grant_secret "$SIGNING_SECRET" "$RUNTIME_EMAIL"
grant_secret "$SIGNING_SECRET" "$WORKER_EMAIL"
# Only the API signs and verifies access tokens.
grant_secret "$JWT_SECRET" "$RUNTIME_EMAIL"
# Deployer: push images, release new revisions, and run them as the runtime account. Nothing else.
gcloud artifacts repositories add-iam-policy-binding "$REGISTRY" --project="$PROJECT_ID" --location="$REGION" \
  --role=roles/artifactregistry.writer --member="serviceAccount:${DEPLOYER_EMAIL}" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --role=roles/run.developer --member="serviceAccount:${DEPLOYER_EMAIL}" --condition=None >/dev/null
for runs_as in "$RUNTIME_EMAIL" "$WORKER_EMAIL"; do
  gcloud iam service-accounts add-iam-policy-binding "$runs_as" --project="$PROJECT_ID" \
    --role=roles/iam.serviceAccountUser --member="serviceAccount:${DEPLOYER_EMAIL}" >/dev/null
done

echo "==> Workload Identity Federation (GitHub Actions, main branch of ${GITHUB_REPO} only)"
exists gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT_ID" --location=global ||
  gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions Pool"
exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT_ID" \
  --location=global --workload-identity-pool="$POOL" ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project="$PROJECT_ID" \
    --location=global --workload-identity-pool="$POOL" --display-name="Wallety repository" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}' && assertion.ref == 'refs/heads/main'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
POOL_ID="$(gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT_ID" --location=global --format='value(name)')"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_REPO}" >/dev/null
PROVIDER_ID="$(gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT_ID" \
  --location=global --workload-identity-pool="$POOL" --format='value(name)')"

echo "==> Cloud Run service (placeholder image; the pipeline replaces it on the first deploy)"
exists gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" ||
  gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --image=us-docker.pkg.dev/cloudrun/container/hello --service-account="$RUNTIME_EMAIL" \
    --max-instances=2 --quiet
# Public API: anyone may call it. Set here once so the deployer never needs permission to change access.
gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --role=roles/run.invoker --member=allUsers >/dev/null

echo "==> Delivery process service (placeholder image; private: only the API may call it)"
exists gcloud run services describe "$WORKER_SERVICE" --project="$PROJECT_ID" --region="$REGION" ||
  gcloud run deploy "$WORKER_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --image=us-docker.pkg.dev/cloudrun/container/hello --service-account="$WORKER_EMAIL" \
    --no-allow-unauthenticated --max-instances=1 --quiet
gcloud run services add-iam-policy-binding "$WORKER_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --role=roles/run.invoker --member="serviceAccount:${RUNTIME_EMAIL}" >/dev/null

cat <<SUMMARY

Done. None of the values below is a secret. Store them as GitHub Actions repository variables:

  GCP_PROJECT_ID=${PROJECT_ID}
  GCP_REGION=${REGION}
  GCP_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER_ID}
  GCP_DEPLOYER_SERVICE_ACCOUNT=${DEPLOYER_EMAIL}
  GCP_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_EMAIL}
  GCP_WORKER_SERVICE_ACCOUNT=${WORKER_EMAIL}
  SERVICE_URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

Remaining manual step: add the three database connection strings as new versions of the
secrets "${DB_SECRET}", "${MIGRATION_DB_SECRET}" and "${DISPATCH_DB_SECRET}" in Secret
Manager (see infra/README.md). Secrets are stored nowhere else.
SUMMARY
