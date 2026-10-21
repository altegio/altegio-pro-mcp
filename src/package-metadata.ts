import packageJson from '../package.json' with { type: 'json' };

interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
}

const parsed = packageJson as Partial<PackageMetadata>;

if (!parsed.name || !parsed.version) {
  throw new Error('package.json must define name and version');
}

export const PACKAGE_NAME = parsed.name;
export const PACKAGE_VERSION = parsed.version;
export const PACKAGE_DESCRIPTION = parsed.description;

export const COMMIT_SHA = process.env.COMMIT_SHA || 'unknown';

/**
 * The version a build reports to MCP clients in `initialize`: the package
 * version, with the commit it was built from as semver build metadata, so two
 * deployments of one version tell apart. A build that does not know its
 * commit reports the package version alone.
 */
export function buildVersion(
  version: string,
  commit: string = COMMIT_SHA
): string {
  return /^[0-9a-f]{7,40}$/i.test(commit)
    ? `${version}+${commit.slice(0, 12).toLowerCase()}`
    : version;
}
