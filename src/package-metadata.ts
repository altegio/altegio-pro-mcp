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
