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
 */
export function toV2(body) {
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
      integrity: { ...rest, strict: strictOf(rest) },
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

/**
 * A trail verdict consistent with the stub's own rows, under the v2 parser's
 * rules (option D, Tasks 203/206): dimensions from the rows, overall from the
 * dimensions, the tail from chain.truncated (count unknown), and
 * chain.verified equal to overall === 'verified'. A stub has no stored rows,
 * so nothing here is a real check.
 */
function strictTrailOf(body, events) {
  const truncated = body.chain?.truncated === true;
  const dim = key => (events.some(e => e.integrity[key] === false) ? 'fail' : 'pass');
  const dimensions = {
    hash: dim('hash_valid'), link: dim('chain_linked'), payload: dim('substance_valid'), agreement: 'pass',
    completeness: truncated || !body.chain?.verified ? 'indeterminate' : 'pass',
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

/** A per-event strict block consistent with the stub's tri-state results. */
function strictOf(integrity) {
  const tri = (v, pass, fail, otherwise) => (v === true ? pass : v === false ? fail : otherwise);
  return {
    kind: integrity.canonical_version_supported ? 'legacy' : 'unsupported',
    hash: tri(integrity.hash_valid, 'match', 'mismatch', 'unsupported'),
    link: tri(integrity.chain_linked, 'linked', 'broken', 'indeterminate'),
    payload: tri(integrity.substance_valid, 'match', 'mismatch', 'not_in_format'),
    agreement: 'not_bound',
  };
}
