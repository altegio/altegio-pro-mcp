# CI/CD: VM-Based Deployment

## Architecture

```
PR merged to main → VM cron (2 min) → git pull → docker compose rebuild
VM: mcp-servers (10.132.0.3, europe-west1-b, e2-small)
Proxy: mcp-proxy (Cloud Run) → mcp.alteg.io
```

### Production Endpoints

| Service | VM Port | Public URL |
|---------|---------|------------|
| altegio-pro-mcp | 3000 | `https://mcp.alteg.io/pro/mcp` |
| bi-data | 8080 | `https://mcp.alteg.io/bi-data/mcp` |

## Quick Start

### Deploy to Production

```bash
git checkout -b feature/my-feature
# ... make changes ...
git push origin feature/my-feature
gh pr create --fill

# After PR approval and CI passes
gh pr merge --merge

# → VM auto-deploys within 2 minutes
```

## Deployment Flow

### 1. CI (GitHub Actions)

**Trigger:** Push/PR to `main`

**Workflow:** `.github/workflows/ci.yml`
- Lint, typecheck, format check
- Tests on Node.js 18, 20, 22
- Build verification
- Security audit (`npm audit`)

### 2. Auto-Deploy (VM Cron)

**Trigger:** Cron every 2 minutes on `mcp-servers` VM

**Process:**
1. `~/deploy.sh` runs `git pull --ff-only origin main`
2. If new commits detected, rebuilds only the changed service
3. `docker compose up -d` restarts the updated container
4. Health check confirms the service is running

**Deploy script:** `~/deploy.sh` on VM

**Docker Compose:** `~/docker-compose.yml` on VM (both services)

### 3. Proxy (Cloud Run)

**Service:** `mcp-proxy` on Cloud Run (`mcp.alteg.io`)

Routes external traffic to VM internal IP:
- `/pro/*` → `10.132.0.3:3000`
- `/bi-data/*` → `10.132.0.3:8080`

## Monitoring

### Check Containers
```bash
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='docker compose ps'
```

### View Logs
```bash
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='docker compose logs altegio-pro-mcp --tail=50'
```

### Deploy Log
```bash
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='tail -20 /var/log/mcp-deploy.log'
```

### Health Checks
```bash
# Via proxy (public)
curl https://mcp.alteg.io/pro/health
curl https://mcp.alteg.io/bi-data/health

# Direct (from internal network)
curl http://10.132.0.3:3000/health
curl http://10.132.0.3:8080/health
```

## Local Testing

### Build Docker Image
```bash
docker build -t altegio-mcp:local .
```

### Run Locally
```bash
docker run --rm -d \
  --name altegio-mcp-local \
  -p 3000:3000 \
  --env-file .env \
  -e PORT=3000 \
  altegio-mcp:local

curl http://localhost:3000/health

docker stop altegio-mcp-local
```

## Troubleshooting

### Container Not Starting
```bash
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='docker compose logs altegio-pro-mcp --tail=100'
```

### Deploy Not Triggering
```bash
# Check cron is running
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='crontab -l'

# Check deploy log
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='tail -20 /var/log/mcp-deploy.log'

# Manual deploy
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap \
  --command='~/deploy.sh'
```

### Proxy Not Routing
```bash
# Check proxy health
curl https://mcp.alteg.io/health

# Check proxy sees both services
curl https://mcp.alteg.io/
```

## Security

### Secrets
- **VM:** `ALTEGIO_API_TOKEN` in `~/.env` (chmod 600)
- **Proxy:** No secrets needed (stateless reverse proxy)

### Network
- VM accessible only via internal IP (10.132.0.3)
- Firewall: `allow-internal-mcp` (tcp:3000, tcp:8080-8090)
- Proxy on Cloud Run handles public HTTPS termination

### SSH Access
```bash
gcloud compute ssh mcp-servers --project=altegio-mcp --zone=europe-west1-b --tunnel-through-iap
```

## Files

- `.github/workflows/ci.yml` — CI checks (lint, test, build, security)
- `Dockerfile` — Multi-stage Node.js 20 Alpine build

---

**Support:** [GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues)
