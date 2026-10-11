// Refuse to run anywhere but the E2E project, before a single request is sent.
//
// WHY THIS IS THE FIRST FILE
// tests/e2e/00-backend-guard.spec.js checks that the *browser* and the tests
// agree on a backend. It cannot help here: this harness has no browser, so the
// mismatch it guards against is not the one that matters. The risk here is
// simpler and worse — the API harness writes real, append-only events, and
// `.env` and `.env.e2e` differ by one hostname. One wrong variable and the
// writes land in production, where UPDATE and DELETE are discarded by rule and
// nothing can be taken back.
//
// So the allowed project is pinned here, in source control, by ref. Not read
// from the environment the run is trying to validate — a guard configured by
// the thing it guards is not a guard. Production is named explicitly as well,
// so the refusal says what actually happened rather than "unexpected host".

/** The only project this harness may ever talk to. */
export const E2E_PROJECT_REF = 'yqjtawffpesplqyurlpj';

/** Named only so the refusal can be specific. Never contacted. */
const PRODUCTION_PROJECT_REF = 'fqgpzhwvvfsxswlnbbgg';

const KNOWN = {
  [E2E_PROJECT_REF]: 'trustflow-e2e',
  [PRODUCTION_PROJECT_REF]: 'trustflow (PRODUCTION)',
};

/** The `<ref>` in `https://<ref>.supabase.co`, or null if it is not that shape. */
export function projectRefOf(url) {
  try {
    const host = new URL(url).hostname;
    const m = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Hard fail unless `url` is the E2E project. Returns the ref on success so a
 * caller can print it; printing a project ref is safe, it is in every URL.
 */
export function assertE2EProject(url, { sourceHint = '.env.e2e' } = {}) {
  const ref = projectRefOf(url ?? '');

  if (ref === E2E_PROJECT_REF) return ref;

  const what = ref === null
    ? `not a Supabase project URL: ${url ?? '(unset)'}`
    : `project ${ref}${KNOWN[ref] ? ` — ${KNOWN[ref]}` : ''}`;

  throw new Error([
    '',
    'REFUSING TO RUN: this harness writes events, and it is not pointed at the',
    'E2E project.',
    '',
    `  configured: ${what}`,
    `  required:   ${E2E_PROJECT_REF} — trustflow-e2e`,
    '',
    ref === PRODUCTION_PROJECT_REF
      ? 'That is PRODUCTION. Events there are append-only: UPDATE and DELETE are\n'
        + 'discarded by rewrite rule, so anything written cannot be removed by anyone.'
      : 'VITE_SUPABASE_URL most likely came from `.env` rather than `.env.e2e`,\n'
        + 'or a shell variable set earlier is overriding the file.',
    '',
    `Check ${sourceHint}, and remember that a real environment variable wins`,
    'over the file.',
    '',
  ].join('\n'));
}

/**
 * A value that must never reach a log: guest tokens, access tokens, invite
 * tokens, email addresses, shareable links. Enough of the head to correlate two
 * lines in one run, never enough to use or to identify a person.
 */
export function redact(value) {
  if (value === null || value === undefined) return '(none)';
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 6)}…(${s.length})`;
}
