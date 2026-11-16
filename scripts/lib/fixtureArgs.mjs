// The only arguments scripts/record-cancel-fixture.mjs accepts. Exactly one of
// three forms; anything else — an unknown flag, a typo, a duplicate, two modes
// at once, or the removed --retry-unsettled — is null, and the script stops
// before it loads any configuration (Codex Task 90: `--chek` used to fall
// through to a recording run, and `--check --resume` ran resume).
//
// Kept apart from the script so it can be tested without importing anything
// that reads credentials.

export const FIXTURE_USAGE = 'usage: node scripts/record-cancel-fixture.mjs [--check | --resume]';

/** 'record' | 'check' | 'resume', or null for anything else. */
export function parseFixtureArgs(argv) {
  if (argv.length === 0) return 'record';
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  if (argv.length === 1 && argv[0] === '--resume') return 'resume';
  return null;
}
