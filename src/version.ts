// Single source of truth for the CLI version. package.json is inlined into the
// bundle at build time, and .releaserc.json builds the release binaries only AFTER
// semantic-release has bumped that file, so a released binary reports its own tag.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
