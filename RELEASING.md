# Releasing Altegio Pro MCP

The public distribution remains an **unpublished source-distributed alpha**.
Versions use `0.x.y-alpha.N`. This procedure creates a GitHub prerelease; npm
and image-registry publication require a separate distribution decision.

1. Update `package.json`, `package-lock.json` and `CHANGELOG.md` in a release PR.
   Run the [required checks](CI-CD.md#checks), artifact probes and trusted pinned
   spec check. Complete independent code review and any configured GitHub
   approvals, then merge with a merge commit.
2. Wait for the successful **push-to-main** CI run for that exact merged SHA.
   Verify its `event`, `head_branch`, `head_sha` and `conclusion` using the GitHub
   API before selecting artifacts. A same-named artifact from a PR run is not a
   release input.
3. Download that run's `package` and `container` artifacts using `gh run download
<run-id> --name <artifact-name> --dir <directory>`. Verify each `SHA256SUMS`
   with `sha256sum --check SHA256SUMS` (macOS: `shasum -a 256 --check SHA256SUMS`).
   Confirm `REVISION` and tarball `dist/build-provenance.json` equal the merged
   SHA. Load the saved image and confirm its ID matches `IMAGE_ID` and its OCI
   revision label. These are the bytes CI tested; do not rebuild for release.
4. Verify the maintained rollout reports the expected **version and commit** at
   `/health`. If rollout health fails, restore the previous verified image/digest
   using the private runbook and verify the restored revision.
5. Create the annotated tag `v<version>` at the verified merged SHA. Create a
   GitHub prerelease for that tag and attach the tested tarball, runtime SBOM,
   checksum/revision files and container archive with image ID. Keep package and
   container checksum sets in distinct named bundles to avoid filename clashes.
   Link the successful CI run and record both the tarball SHA256 and image ID in
   the release notes. Never move an existing release tag to different bytes.

The tarball itself is verified; npm installation can resolve newer compatible
dependencies. Use the verified container or source checkout with `npm ci` when
the exact locked dependency tree is required.

The Actions artifact IDs/digests bind downloads to that run. The embedded
revision and lockfile hash are reproducibility metadata; no signed provenance
claim is made. Retain prerelease assets beyond CI's seven-day artifact retention.

Patch bumps fix behavior without intentionally changing tool contracts. Minor
bumps add or intentionally change tools, resources, prompts, authentication or
runtime requirements. The first stable contract will be `1.0.0`.
