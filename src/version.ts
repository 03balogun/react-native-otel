// Single source of truth for the SDK version string.
// Update this when bumping the package version.

export const SDK_VERSION: string = (
  require('../package.json') as { version: string }
).version;
