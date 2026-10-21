import { describe, expect, it } from '@jest/globals';
import { buildVersion } from '../package-metadata.js';

describe('the version a build reports', () => {
  it('carries the commit it was built from as build metadata', () => {
    expect(
      buildVersion('0.7.0-alpha.0', '119C705A8B9e0d1f2a3b4c5d6e7f8091a2b3c4d5')
    ).toBe('0.7.0-alpha.0+119c705a8b9e');
    expect(buildVersion('0.7.0', 'abc1234')).toBe('0.7.0+abc1234');
  });

  it('is the package version alone when the build does not know a commit', () => {
    expect(buildVersion('0.7.0', 'unknown')).toBe('0.7.0');
    expect(buildVersion('0.7.0', '')).toBe('0.7.0');
    expect(buildVersion('0.7.0', 'main; rm -rf')).toBe('0.7.0');
  });
});
