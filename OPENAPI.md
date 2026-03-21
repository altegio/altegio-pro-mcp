# OpenAPI Specification

## Overview

Corporate OpenAPI specification lives in a separate repository cloned alongside this project at `../biz.erp.api.docs/`.

**Main spec file:** `../biz.erp.api.docs/docs/altegio/en/openapi.yml`

## Workflow

**IMPORTANT:** Before starting any new task, ALWAYS pull the latest specification:

```bash
git -C ../biz.erp.api.docs pull origin master
```

## Usage in Development

When implementing new features or fixing bugs, always check the OpenAPI spec first:
- Main file: `../biz.erp.api.docs/docs/altegio/en/openapi.yml`
- Responses: `../biz.erp.api.docs/docs/altegio/en/responses/`

## Critical Rules

**NEVER modify anything inside `../biz.erp.api.docs/`!**

- This is a separate repository, read-only for this project
- All changes must be made in the source repository directly

## Alternative Access

If you don't have the repository cloned locally, the API documentation is also available at:
- https://developer.alteg.io/api (cached at `/tmp/alteg_api.html`)
