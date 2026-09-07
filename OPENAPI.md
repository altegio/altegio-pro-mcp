# OpenAPI Specification

## Overview

Corporate OpenAPI specification lives in a separate repository cloned alongside this project at `../biz.erp.api.docs/`.

**Spec files:** `../biz.erp.api.docs/docs/en/b2b-v1/openapi.yaml` (v1, legacy but live), `../biz.erp.api.docs/docs/en/b2b-v3/openapi.yaml` (V3 preview, October 2026), `../biz.erp.api.docs/docs/en/public/openapi.yaml`, `../biz.erp.api.docs/docs/en/developers/openapi.yaml`. `docs/en/b2b-v2/openapi.yaml` is internal-only by API-team policy.

## Workflow

**IMPORTANT:** Before starting any new task, ALWAYS pull the latest specification:

```bash
git -C ../biz.erp.api.docs pull origin master
```

## Usage in Development

When implementing new features or fixing bugs, always check the OpenAPI spec first:
- Main files: `../biz.erp.api.docs/docs/en/b2b-v1/openapi.yaml`, `../biz.erp.api.docs/docs/en/b2b-v3/openapi.yaml`
- Path items: `../biz.erp.api.docs/docs/en/paths/**` (referenced via `$ref` from the spec files)
- Schemas and responses: `../biz.erp.api.docs/docs/en/schemas/**`, `../biz.erp.api.docs/docs/en/components/responses/`

## Critical Rules

**NEVER modify anything inside `../biz.erp.api.docs/`!**

- This is a separate repository, read-only for this project
- All changes must be made in the source repository directly

## Alternative Access

If you don't have the repository cloned locally, the API documentation is also available at:
- https://developer.alteg.io/api (cached at `/tmp/alteg_api.html`)
