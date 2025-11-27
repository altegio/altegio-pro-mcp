# OpenAPI Specification

## Overview

Corporate OpenAPI specification is available locally in `api.docs/` directory. This is a private corporate repository that is NOT included in the open source GitHub repository.

**Main spec file:** `api.docs/docs/altegio/en/openapi.yml`

## Initial Setup

```bash
# Clone the OpenAPI docs repository (corporate access required)
git clone git@gitlab.altegio.dev:altegio/biz.erp.api.docs.git api.docs
```

## Workflow

**IMPORTANT:** Before starting any new task, ALWAYS pull the latest specification:

```bash
git -C api.docs pull origin master
```

This ensures you're working with the most up-to-date API documentation.

## Usage in Development

When implementing new features or fixing bugs, always check the OpenAPI spec first:
- Main file: `api.docs/docs/altegio/en/openapi.yml`
- Responses: `api.docs/docs/altegio/en/responses/`

## Critical Rules

**⚠️ NEVER modify anything inside `api.docs/` directory!**

- This is a submodule managed in a separate GitLab project
- All changes must be made in the source repository: `git@gitlab.altegio.dev:altegio/biz.erp.api.docs.git`
- Local modifications will be lost on next pull
- This directory is read-only for this project

## Security Note

**IMPORTANT:** This directory is gitignored and will NOT be pushed to the public GitHub repository. The OpenAPI specs contain corporate internal documentation and must remain private.

## Alternative Access

If you don't have access to the GitLab repository, the API documentation is also available at:
- https://developer.alteg.io/api (cached at `/tmp/alteg_api.html`)
