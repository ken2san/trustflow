import { describe, it, expect } from 'vitest'
import {
  CANONICAL_INPUTS, PAYLOAD_ALLOWLIST, filterPayload, canonicalInputsOf,
  missingCanonicalInputs, recomputeFromCanonicalBlock, guestVerificationNotes,
} from '../../supabase/functions/_shared/guestEventView.ts'
import {
  eventCanonical, HASH_VERSION,
} from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildEventRecord } from '../../supabase/functions/_shared/eventRecord.ts'
import { bearerAssurance } from '../../supabase/functions/_shared/authAssurance.ts'

const CONTRACT = {
  id: '22222222-2222-4222-8222-222222222222',
  project_name: 'Certified translation',
  dod: ['translate', 'return a stamped PDF'],
  amount_jpy: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  earner_display_name: 'Acme Translations',
  invited_hirer_email: 'invited@example.test',
  hirer_email: 'invited@example.test',
}

// A stored row, as PostgREST hands it back.
const rowFrom = (record) => ({
  id: record.id,
  type: record.type,
  actor_id: record.actor_id,
  payload: record.payload,
  dod_hash: record.dod_hash,
  created_at: record.created_at,
  event_hash: record.event_hash,
  prev_event_hash: record.prev_event_hash,
  hash_version: record.hash_version,
  payload_hash: record.payload_hash,
  agreement_hash: record.agreement_hash,
})

const assertionRecord = (overrides = {}) => buildEventRecord({
  type: 'performance.asserted',
  contract: CONTRACT,
  actorId: 'guest:invited@example.test',
  party: 'guest_hirer',
  assurance: bearerAssurance('guest_access_token'),
  payload: { step: 3, note: 'delivered the stamped PDF' },
  prevEventHash: 'GENESIS',
  ...overrides,
})

// ── the set of inputs, derived rather than remembered ────────────────────────
// The guest could not recompute anything because three of the nine canonical
// inputs were never sent. The failure mode to prevent is that happening again
// silently, so the list is checked against the canonical itself.

describe('CANONICAL_INPUTS', () => {
  it('is exactly what the canonical string is built from', () => {
    const block = canonicalInputsOf(rowFrom({
      id: 'e1', type: 'performance.asserted', actor_id: 'a', dod_hash: 'd',
      created_at: '2026-10-11T00:00:00.000Z', prev_event_hash: 'GENESIS',
      payload_hash: 'p', agreement_hash: 'g', hash_version: 4, payload: {},
      event_hash: 'x',
    }), CONTRACT.id)

    const consumed = Object.keys(JSON.parse(eventCanonical(block, HASH_VERSION)))
      // The canonical names the chain link `prev_hash`; the row names it
      // `prev_event_hash`. Same field, two spellings, and the mapping is the
      // kind of detail that silently loses a field.
      .map(k => (k === 'prev_hash' ? 'prev_event_hash' : k))

    // hash_version is not hashed — it selects WHICH canonical applies, so a
    // verifier needs it even though it is not inside the string.
    expect([...CANONICAL_INPUTS].sort()).toEqual([...consumed, 'hash_version'].sort())
  })

  it('names only load-bearing fields: changing any one changes the hash', async () => {
    const record = await assertionRecord()
    const block = canonicalInputsOf(rowFrom(record), CONTRACT.id)
    const baseline = await recomputeFromCanonicalBlock(block)

    for (const field of CANONICAL_INPUTS) {
      if (field === 'hash_version') continue // selects the version, tested below
      const tampered = { ...block, [field]: `${block[field]}-changed` }
      expect(await recomputeFromCanonicalBlock(tampered)).not.toBe(baseline)
    }
  })

  it('counts a downgraded hash_version as a different computation', async () => {
    const record = await assertionRecord()
    const block = canonicalInputsOf(rowFrom(record), CONTRACT.id)
    // The evasion worth naming: claim an older canonical so the fields added
    // later stop being covered.
    expect(await recomputeFromCanonicalBlock({ ...block, hash_version: 3 }))
      .not.toBe(record.event_hash)
  })
})

// ── the guest can now do what the owner could ────────────────────────────────

describe('what a guest can check with no access to TrustFlow', () => {
  it('recomputes an event_hash from the canonical block alone', async () => {
    const record = await assertionRecord()
    const block = canonicalInputsOf(rowFrom(record), CONTRACT.id)

    expect(missingCanonicalInputs(block)).toEqual([])
    expect(await recomputeFromCanonicalBlock(block)).toBe(record.event_hash)
  })

  it('reports exactly which inputs are missing when some are', () => {
    // The state the response was in before this change: the digests, and
    // neither the version nor two of the inputs.
    const { hash_version, payload_hash, agreement_hash, ...partial } =
      canonicalInputsOf({ id: 'e', type: 't', actor_id: 'a', dod_hash: 'd',
        created_at: 'c', prev_event_hash: 'GENESIS', payload_hash: 'p',
        agreement_hash: 'g', hash_version: 4 }, CONTRACT.id)

    expect(missingCanonicalInputs(partial).sort())
      .toEqual(['agreement_hash', 'hash_version', 'payload_hash'])
    expect(missingCanonicalInputs(null)).toEqual([...CANONICAL_INPUTS])
  })

  it('follows a chain of acts and sees a removal', async () => {
    const first = await assertionRecord({ type: 'dod.consent_recorded', prevEventHash: 'GENESIS' })
    const second = await assertionRecord({ prevEventHash: first.event_hash })
    const third = await assertionRecord({
      type: 'performance.accepted', prevEventHash: second.event_hash,
    })

    const acts = [first, second, third].map(r => canonicalInputsOf(rowFrom(r), CONTRACT.id))
    const linked = (list) => list.every((a, i) =>
      a.prev_event_hash === (i === 0 ? 'GENESIS' : list[i - 1].event_hash_stored))
    const withStored = (list, records) =>
      list.map((a, i) => ({ ...a, event_hash_stored: records[i].event_hash }))

    expect(linked(withStored(acts, [first, second, third]))).toBe(true)
    // Drop the middle act: the third no longer points at the one before it.
    expect(linked(withStored([acts[0], acts[2]], [first, third]))).toBe(false)
  })
})

// ── the allowlist ────────────────────────────────────────────────────────────

describe('what leaves the server', () => {
  it('never carries an underscore-prefixed key, whatever the table says', async () => {
    const record = await assertionRecord()
    // The payload really does contain them: _actor_role, _authentication, …
    expect(Object.keys(record.payload).some(k => k.startsWith('_'))).toBe(true)

    const shown = filterPayload(record.type, record.payload)
    expect(Object.keys(shown).some(k => k.startsWith('_'))).toBe(false)
    expect(JSON.stringify(shown)).not.toContain('_authentication')
  })

  it('allowlists no underscore key in the table itself', () => {
    for (const [type, keys] of Object.entries(PAYLOAD_ALLOWLIST)) {
      for (const key of keys) {
        expect(key.startsWith('_'), `${type}.${key}`).toBe(false)
      }
    }
  })

  it('gives an unknown type an empty payload rather than passing it through', () => {
    expect(filterPayload('type.nobody.reviewed', { secret: 'x', step: 1 })).toEqual({})
  })

  it('lets a party read back their own statement on both sides of a delivery', () => {
    // Reported earlier and fixed here: the receiver writes a note when they
    // accept, and could not read it back. A party unable to see what the
    // record says they said cannot dispute it.
    expect(PAYLOAD_ALLOWLIST['performance.asserted']).toContain('note')
    expect(PAYLOAD_ALLOWLIST['performance.accepted']).toContain('note')
    expect(filterPayload('performance.accepted', { step: 4, note: 'received, thanks' }))
      .toEqual({ step: 4, note: 'received, thanks' })
  })

  it('shows an access reissue with no detail, but shows it', () => {
    // The guest is the party most entitled to know their credential changed.
    expect(PAYLOAD_ALLOWLIST).toHaveProperty('access.reissued')
    expect(filterPayload('access.reissued', { anything: 1 })).toEqual({})
  })
})

// ── the limits travel with the data ──────────────────────────────────────────

describe('guestVerificationNotes', () => {
  it('states the payload-preimage gap rather than implying it is closed', () => {
    const notes = guestVerificationNotes()
    const text = notes.not_verifiable_here.join(' ')
    expect(text).toContain('payload_hash')
    expect(text).toContain('allowlisted projection')
  })

  it('does not claim the chain proves identity, performance or payment', () => {
    const text = guestVerificationNotes().not_verifiable_here.join(' ')
    expect(text).toContain('identity')
    expect(text).toContain('work was performed')
    expect(text).toContain('same history')
  })

  it('claims only the four things the hashes actually establish', () => {
    const notes = guestVerificationNotes()
    expect(notes.independently_verifiable).toHaveLength(3)
    expect(notes.independently_verifiable.join(' ')).not.toContain('identity')
  })
})
