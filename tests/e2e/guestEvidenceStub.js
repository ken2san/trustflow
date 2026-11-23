// Shared pieces for specs that stub guest-contract-events.
//
// Since the rank-1 provenance fix the page asks for
// `guest-contract-events?response_version=2`. A stub routed on the bare path
// no longer matches that URL, and the request would silently go to the live
// backend instead, so the stub glob ends in `*`, every stubbed request is
// checked for the parameter, and any other Edge Function call fails the test.

/** Matches the endpoint with or without a query string. */
export const GUEST_EVENTS_ROUTE = '**/functions/v1/guest-contract-events*';

/**
 * Record and abort every Edge Function call no later route handles. Register
 * it BEFORE the specific stubs: Playwright tries the most recently registered
 * matching route first, so the stubs still win.
 *
 * @returns {{ unexpected: string[], guestEventUrls: string[] }} filled as the page runs
 */
export async function guardFunctionCalls(page) {
  const seen = { unexpected: [], guestEventUrls: [] };
  await page.route('**/functions/v1/**', route => {
    seen.unexpected.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  return seen;
}

/** True when a guest-contract-events request asked for exactly version 2. */
export function askedForV2(url) {
  return JSON.stringify(new URL(url).searchParams.getAll('response_version')) === '["2"]';
}

/**
 * A version 1 body (what today's function, or one rolled back, returns even
 * when version 2 is asked for) rewritten as the version 2 shape.
 *
 * NOT A v2 ORACLE BY ITSELF (Codex T177). A version 1 body cannot carry the
 * evidence a strict pass needs, so each row's strict labels are built
 * conservatively from its tri-states and anything v1 cannot express stays
 * indeterminate. The trail verdict is then derived from those rows by the
 * same rule the page's parser enforces. `agreementChecked: true` is the
 * fixture stating that the server compared every format 4 row's agreement
 * digest with the accepted snapshot and it matched; without it, a v4 row's
 * agreement is indeterminate and the record cannot verify.
 */
export function toV2(body, { agreementChecked = false } = {}) {
  const { server_attested: v2OrLater = 0, client_asserted: belowV2 = 0, ...chain } = body.chain ?? {};
  const events = (body.events ?? []).map(({ actor, integrity, ...ev }) => {
    const rest = { ...integrity };
    delete rest.trust_model;
    return {
      ...ev,
      actor: {
        id: actor?.id ?? null,
        attribution: 'as_recorded_not_verified',
        recorded_id_class: actor?.id == null ? 'missing' : 'other',
      },
      provenance: { writer: 'unknown', basis: 'none_recorded' },
      integrity: { ...rest, strict: strictOf(rest, { agreementChecked }) },
    };
  });
  const trail = strictTrailOf(body, events);
  return {
    ...body,
    response_version: 2,
    chain: {
      ...chain, events_format_v2_or_later: v2OrLater, events_format_below_v2: belowV2,
      event_count: events.length, verified: trail.server.overall === 'verified',
    },
    events,
    strict_verification: trail,
  };
}

// The strict slice's label sets (supabase/functions/_shared/eventVerifyV5.ts).
const STRICT_FAIL = ['mismatch', 'broken', 'invalid', 'invalid_input'];
const STRICT_PASS = ['match', 'linked', 'pre_acceptance', 'not_in_format', 'not_bound'];

/**
 * A trail verdict derived from the rows' strict labels: a dimension fails on
 * any failing label and passes only when every label passes; completeness
 * passes only for an untruncated, nonempty trail. A stub has no stored rows,
 * so nothing here is a real check.
 */
function strictTrailOf(body, events) {
  const truncated = body.chain?.truncated === true;
  const dim = key => {
    const labels = events.map(e => e.integrity.strict[key]);
    if (labels.some(v => STRICT_FAIL.includes(v))) return 'fail';
    return labels.every(v => STRICT_PASS.includes(v)) ? 'pass' : 'indeterminate';
  };
  const dimensions = {
    hash: dim('hash'), link: dim('link'), payload: dim('payload'), agreement: dim('agreement'),
    completeness: !truncated && events.length > 0 ? 'pass' : 'indeterminate',
  };
  const all = Object.values(dimensions);
  const overall = all.includes('fail') ? 'failed' : all.every(d => d === 'pass') ? 'verified' : 'incomplete';
  return {
    server: {
      overall, dimensions,
      acceptance: { status: 'caller' },
      read_boundary: truncated
        ? { start: 'first_event', tail: 'unknown', recorded_count: null }
        : { start: 'first_event', tail: 'complete', recorded_count: events.length },
    },
    server_agreement: { status: 'no_acceptance', hash: null, acceptance_index: null },
    local_note: 'Stubbed response; no strict check ran.',
  };
}

/** A per-event strict block from v1 tri-states; what v1 cannot show stays unproven. */
function strictOf(integrity, { agreementChecked }) {
  const supported = integrity.canonical_version_supported === true;
  const version = integrity.canonical_version;
  const tri = (v, pass, fail, otherwise) => (v === true ? pass : v === false ? fail : otherwise);
  return {
    kind: supported ? 'legacy' : 'unsupported',
    hash: tri(integrity.hash_valid, 'match', 'mismatch', supported ? 'missing' : 'unsupported'),
    link: tri(integrity.chain_linked, 'linked', 'broken', 'indeterminate'),
    payload: tri(integrity.substance_valid, 'match', 'mismatch', supported && version < 3 ? 'not_in_format' : 'indeterminate'),
    agreement: !supported ? 'indeterminate'
      : version < 4 ? 'not_bound'
        : agreementChecked ? 'match' : 'indeterminate',
  };
}
