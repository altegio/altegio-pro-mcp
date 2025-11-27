# CI/CD: Multi-Environment Deployment

Automated deployment pipeline with **production** (main) and **staging** (PR) environments.

## Architecture

### Production Environment
```
PR merged to main → Cloud Build → Production
Service: altegio-mcp
Region: europe-west1
Resources: 512Mi RAM, 1 CPU, scale to zero
```

### Staging Environments
```
PR opened/updated → Cloud Build Gen2 Trigger → Staging Deploy
Service: altegio-mcp-{branch-name}
Region: europe-west1
Resources: 512Mi RAM, 1 CPU, scale to zero
Auto-cleanup: 3 days
```

**Configuration:**
- Trigger: `mcp-pro-staging` (Gen2)
- Repository: GitHub via Cloud Build 2nd gen connection
- Comment control: Enabled for external contributors

## Quick Start

### Deploy to Staging (Pull Request)
```bash
git checkout -b feature/my-feature
# ... make changes ...
git push origin feature/my-feature

# Create PR via GitHub UI or CLI
gh pr create --fill

# → Cloud Build Gen2 trigger fires automatically
# → Staging deployment starts
# → Check status in PR checks
```

### Deploy to Production (Merge to Main)
```bash
# After PR approval and all checks pass
gh pr merge --merge

# → Automatic production deployment via Cloud Build
```

## Deployment Flow

### 1. Staging Deployment (Pull Requests)

**Trigger:** PR opened/synchronized targeting `main`

**Cloud Build Gen2 Trigger:** `mcp-pro-staging`

**Process:**
1. PR created/updated on GitHub
2. Cloud Build Gen2 trigger fires automatically
3. Sanitizes branch name (removes /, lowercase)
4. Builds Docker image with `staging-{SHA}` tag
5. Deploys to `altegio-mcp-{sanitized-branch}`
6. Service scales to zero when idle
7. Auto-deleted after 3 days

**Quality Gates:**
Separate CI workflow (`.github/workflows/ci.yml`) runs in parallel:
- Lint, test, build
- Doesn't block staging deployment

**Example:**
```bash
# Branch: feature/user-management
# Service: altegio-mcp-feature-user-management
# URL: https://altegio-mcp-feature-user-management-{hash}.a.run.app
```

**Config:**
- Memory: 512Mi
- CPU: 1
- Min instances: 0 (scale to zero)
- Max instances: 5
- Timeout: 3600s
- Environment: NODE_ENV=staging, LOG_LEVEL=debug

### 2. Production Deployment (Main Branch)

**Trigger:** Push to `main` branch (after PR merge)

**Cloud Build Gen2 Trigger:** `mcp-pro-production`

**Process:**
1. PR merged to main
2. Cloud Build Gen2 trigger fires on push
3. Builds Docker image with `production`, `latest`, and `{SHA}` tags
4. Deploys to `altegio-mcp`
5. Scales to zero when idle for cost optimization

**Note:** Direct pushes to main are blocked by branch protection rules

**Config:**
- Memory: 512Mi
- CPU: 1
- Min instances: 0 (scale to zero)
- Max instances: 10
- Timeout: 3600s
- Environment: NODE_ENV=production, LOG_LEVEL=info

## Monitoring

### Check Build Status
```bash
# List recent builds
gcloud builds list --limit=5 --project=altegio-mcp

# Watch build logs
gcloud builds log BUILD_ID --project=altegio-mcp --stream
```

### Check Deployments
```bash
# List all services
gcloud run services list --region=europe-west1 --project=altegio-mcp

# Production service
gcloud run services describe altegio-mcp \
  --region=europe-west1 \
  --project=altegio-mcp

# Staging services
gcloud run services list \
  --region=europe-west1 \
  --filter="metadata.name:altegio-mcp-*" \
  --project=altegio-mcp
```

### Service Logs
```bash
# Production logs
gcloud run services logs read altegio-mcp \
  --region=europe-west1 \
  --limit=50 \
  --project=altegio-mcp

# Staging logs
gcloud run services logs read altegio-mcp-feature-my-feature \
  --region=europe-west1 \
  --limit=50 \
  --project=altegio-mcp
```

## Cleanup Automation

**Schedule:** Daily at 2 AM UTC

**Policy:** Deletes staging services older than 3 days

**Manual Cleanup:**
```bash
# Trigger cleanup manually
gcloud builds submit \
  --config=cloudbuild-cleanup.yaml \
  --project=altegio-mcp

# Or delete specific service
gcloud run services delete altegio-mcp-feature-old \
  --region=europe-west1 \
  --project=altegio-mcp \
  --quiet
```

## Setup Instructions

### First-Time Setup

**1. Create Cloud Build Gen2 Connection:**
```bash
# Enable required services
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com

# Grant Secret Manager permissions to Cloud Build
gcloud projects add-iam-policy-binding altegio-mcp \
  --member="serviceAccount:service-767969350727@gcp-sa-cloudbuild.iam.gserviceaccount.com" \
  --role="roles/secretmanager.admin"

# Create Gen2 GitHub connection
gcloud alpha builds connections create github github-gen2 \
  --region=europe-west1

# Follow the OAuth link to authorize GitHub
# Then add repository:
gcloud alpha builds repositories create altegio-pro-mcp \
  --remote-uri=https://github.com/altegio/altegio-pro-mcp.git \
  --connection=github-gen2 \
  --region=europe-west1
```

**2. Create Cloud Build Triggers:**

Via Console (recommended):
1. Go to: https://console.cloud.google.com/cloud-build/triggers?project=altegio-mcp
2. **Staging Trigger:**
   - Name: `mcp-pro-staging`
   - Event: Pull request
   - Repository (2nd gen): `github-gen2` / `altegio-pro-mcp`
   - Base branch: `^main$`
   - Build config: `cloudbuild-staging.yaml`
   - Region: `europe-west1`
3. **Production Trigger:**
   - Name: `mcp-pro-production`
   - Event: Push to branch
   - Repository (2nd gen): `github-gen2` / `altegio-pro-mcp`
   - Branch: `^main$`
   - Build config: `cloudbuild.yaml`
   - Region: `europe-west1`

**3. Grant Permissions to Service Account:**
```bash
# Create service account for triggers
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions"

# Grant required permissions
gcloud projects add-iam-policy-binding altegio-mcp \
  --member="serviceAccount:github-actions@altegio-mcp.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.editor"

gcloud projects add-iam-policy-binding altegio-mcp \
  --member="serviceAccount:github-actions@altegio-mcp.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding altegio-mcp \
  --member="serviceAccount:github-actions@altegio-mcp.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding altegio-mcp \
  --member="serviceAccount:github-actions@altegio-mcp.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

# Allow SA impersonation
gcloud iam service-accounts add-iam-policy-binding \
  767969350727-compute@developer.gserviceaccount.com \
  --member="serviceAccount:github-actions@altegio-mcp.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

**4. Verify Setup:**
```bash
# Check Gen2 connection
gcloud alpha builds connections describe github-gen2 --region=europe-west1

# Check repositories
gcloud alpha builds repositories list \
  --connection=github-gen2 \
  --region=europe-west1

# Check triggers
gcloud alpha builds triggers list --region=europe-west1
```

### Manual Setup (Alternative)

**1. Create Production Trigger:**
```bash
gcloud builds triggers create github \
  --name="altegio-mcp-production" \
  --repo-name="altegio-pro-mcp" \
  --repo-owner="petroff" \
  --branch-pattern="^main$" \
  --build-config="cloudbuild.yaml" \
  --region="europe-west1" \
  --project="altegio-mcp"
```

**2. Create Staging Trigger:**
```bash
gcloud builds triggers create github \
  --name="altegio-mcp-staging" \
  --repo-name="altegio-pro-mcp" \
  --repo-owner="petroff" \
  --branch-pattern="^(?!main$).*" \
  --build-config="cloudbuild-staging.yaml" \
  --region="europe-west1" \
  --project="altegio-mcp"
```

**3. Create Cleanup Job:**
```bash
gcloud scheduler jobs create http staging-cleanup \
  --location=europe-west1 \
  --schedule="0 2 * * *" \
  --time-zone="UTC" \
  --uri="https://cloudbuild.googleapis.com/v1/projects/altegio-mcp/triggers/altegio-mcp-cleanup:run" \
  --http-method=POST \
  --oidc-service-account-email="altegio-mcp@appspot.gserviceaccount.com"
```

## Local Testing

### Build Docker Image
```bash
docker build -t altegio-mcp:local .
```

### Run Locally
```bash
# Using .env
docker run --rm -d \
  --name altegio-mcp-local \
  -p 8080:8080 \
  --env-file .env \
  altegio-mcp:local

# Test
curl http://localhost:8080/health

# Stop
docker stop altegio-mcp-local
```

### Test Build Config
```bash
# Test production build
gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=altegio-mcp

# Test staging build
gcloud builds submit \
  --config=cloudbuild-staging.yaml \
  --substitutions=BRANCH_NAME=test-branch \
  --project=altegio-mcp
```

## Troubleshooting

### Build Failures

**Check logs:**
```bash
gcloud builds list --limit=1 --project=altegio-mcp
BUILD_ID=$(gcloud builds list --limit=1 --format="value(id)" --project=altegio-mcp)
gcloud builds log $BUILD_ID --project=altegio-mcp
```

**Common issues:**
- ❌ Region mismatch: Check cloudbuild.yaml uses `europe-west1`
- ❌ Secret not found: Verify `altegio-api-token` exists in Secret Manager
- ❌ Permissions: Cloud Build SA needs `run.admin` role

### Deployment Failures

**Check service status:**
```bash
gcloud run services describe SERVICE_NAME \
  --region=europe-west1 \
  --project=altegio-mcp
```

**Check logs:**
```bash
gcloud run services logs read SERVICE_NAME \
  --region=europe-west1 \
  --limit=100 \
  --project=altegio-mcp
```

### Staging Not Deploying

**Verify trigger:**
```bash
gcloud builds triggers describe altegio-mcp-staging --project=altegio-mcp
```

**Check branch pattern:**
- Pattern: `^(?!main$).*` (all branches except main)
- File: `cloudbuild-staging.yaml`

### Cleanup Not Running

**Check scheduler job:**
```bash
gcloud scheduler jobs describe staging-cleanup \
  --location=europe-west1 \
  --project=altegio-mcp
```

**Trigger manually:**
```bash
gcloud scheduler jobs run staging-cleanup \
  --location=europe-west1 \
  --project=altegio-mcp
```

## Cost Optimization

### Production
- **Scale to zero:** No cost when idle (optimized)
- **Monthly cost:** ~$5-10 (512Mi RAM, 1 CPU, usage-based)

### Staging
- **Scale to zero:** No cost when idle
- **Auto-cleanup:** 3 days retention
- **Monthly cost:** ~$10-20 (3-5 active branches)

### Total Estimated Cost
- **Before optimization:** ~$50/month (1Gi RAM, 2 CPU, min 1 instance)
- **After optimization:** ~$15-30/month (512Mi RAM, 1 CPU, scale to zero)
- **Savings:** ~$35-40/month (~70% reduction)

## Security

### Secrets Management
- **Storage:** Google Cloud Secret Manager
- **Access:** Cloud Build service account only
- **Secret name:** `altegio-api-token`
- **Usage:** All environments use same token

### Service Authentication
- **Public URL:** Yes (`--allow-unauthenticated`)
- **API Auth:** Required via ALTEGIO_API_TOKEN
- **Reason:** MCP protocol requires direct access

### IAM Roles
```bash
# Cloud Build service account needs:
- roles/run.admin              # Deploy services
- roles/secretmanager.secretAccessor  # Read secrets
- roles/iam.serviceAccountUser # Act as service account
```

## Files

- `cloudbuild.yaml` - Production deployment (Gen2 trigger on push to main)
- `cloudbuild-staging.yaml` - Staging deployment (Gen2 trigger on PR to main)
- `cloudbuild-cleanup.yaml` - Cleanup automation (scheduled)
- `.github/workflows/ci.yml` - CI checks for all branches (lint, test, build)

## Best Practices

1. **Test in staging first:** Create PR → test staging deploy → merge to main
2. **Check build logs:** Monitor Cloud Build console (europe-west1)
3. **Use semantic commits:** Helps track what triggered deployments
4. **Delete old branches:** Reduces number of staging services
5. **Monitor costs:** Check GCP billing dashboard regularly

## Architecture Summary

**All triggers use Cloud Build 2nd gen repositories:**
- Connection: `github-gen2` (europe-west1)
- Repository: `altegio-pro-mcp`
- Triggers: `mcp-pro-staging`, `mcp-pro-production`

**Benefits:**
- Native PR support (no GitHub Actions needed)
- Regional control (europe-west1)
- Single place for all CI/CD (Cloud Build console)
- Better GitHub integration

---

**Setup:** `./scripts/setup-triggers.sh`
**Support:** [GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues)
