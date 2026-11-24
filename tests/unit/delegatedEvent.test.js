import { describe, it, expect } from 'vitest'
import {
  assuranceForRecord, bearerAssurance, grantAssurance, legacyAuthMethod, assuranceMeaning,
} from '../../supabase/functions/_shared/authAssurance.ts'
import {
  buildDelegatedEventV5, expectedReservedFields, finalRecordedTree, inDelegatedDomain,
} from '../../supabase/functions/_shared/delegatedEvent.ts'
import { buildEventCanonicalV5, verifyEventHashV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import { payloadHash } from '../../supabase/functions/_shared/eventCanonical.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const GRANT = 'cccccccc-0000-4000-8000-000000000001'
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

describe('grant assurance (entry_agent_grant)', () => {
  it('equals the SQL constant private.v5_grant_authentication() (20261124130000), byte for byte as jsonb', () => {
    expect(assuranceForRecord(grantAssurance())).toEqual({
      assurance: 'bearer_capability', credential: 'entry_agent_grant', method: null, aal: null,
      seconds_since_authentication: null, recent_authentication: false,
      recent_authentication_window_seconds: 300, act_bound_authentication: false, act_binding_mechanism: null,
    })
  })
  it('records the grant label, and leaves the existing mappings unchanged', () => {
    expect(legacyAuthMethod(grantAssurance())).toBe('entry_agent_grant')
    expect(legacyAuthMethod(bearerAssurance('guest_access_token'))).toBe('invite_capability')
    expect(legacyAuthMethod(bearerAssurance('invite_token'))).toBe('invite_capability')
  })
  it('assuranceMeaning has its own grant branch, never the invitation wording', () => {
    const m = assuranceMeaning(grantAssurance())
    expect(m.proves.join(' ')).toContain('agent grant')
    expect(m.proves.join(' ')).not.toContain('invitation')
    expect(m.does_not_prove.join(' ')).toContain('owner personally')
  })
})

describe('reserved fields, both performed_by directions', () => {
  it('creator: the owner performs; counterparty: the owner receives', () => {
    expect(expectedReservedFields('creator')._role_in_agreement).toBe('performer')
    expect(expectedReservedFields('counterparty')._role_in_agreement).toBe('receiver')
    expect(expectedReservedFields('creator')._actor_role).toBe('earner')
    expect(expectedReservedFields('creator')._auth_method).toBe('entry_agent_grant')
  })
})

describe('the final recorded tree', () => {
  it('duplicate keys: last wins for ordinary keys, and caller reserved fields never survive', () => {
    const body = '{"note":"first","note":"second","_auth_method":"account_session","_auth_method":"x",'
      + '"_authentication":{"assurance":"account_session"},"_actor_role":"guest_hirer","_role_in_agreement":"receiver",'
      + '"_extra":1,"nested":{"_kept":true}}'
    const tree = finalRecordedTree(JSON.parse(body).valueOf(), 'creator')
    expect(tree.note).toBe('second')
    expect(tree.nested).toEqual({ _kept: true })
    expect(Object.keys(tree).filter((k) => k.startsWith('_')).sort())
      .toEqual(['_actor_role', '_auth_method', '_authentication', '_role_in_agreement'])
    expect(tree._auth_method).toBe('entry_agent_grant')
    expect(tree._actor_role).toBe('earner')
    expect(tree._role_in_agreement).toBe('performer')
    expect(tree._authentication).toEqual(assuranceForRecord(grantAssurance()))
  })
  it('readback of the stored tree (a JSON round trip) recomputes to the same payload hash', async () => {
    const tree = finalRecordedTree({ note: 'x', n: 3, ok: true, list: [1, 'a', null] }, 'counterparty')
    expect(await payloadHash(JSON.parse(JSON.stringify(tree)))).toBe(await payloadHash(tree))
  })
  it.each([
    ['a float', { n: 1.5 }],
    ['an unsafe integer', { n: 2 ** 53 }],
    ['\\u0000', { s: 'a\u0000b' }],
    ['a lone high surrogate', { s: '\uD800' }],
    ['a lone low surrogate', { s: '\uDC00x' }],
    ['a key with \\u0000', { 'a\u0000': 1 }],
    ['an array body', [1, 2]],
  ])('refuses %s', (_label, payload) => {
    expect(finalRecordedTree(payload, 'creator')).toBeNull()
  })
  it('accepts a valid surrogate pair and nested plain data', () => {
    expect(inDelegatedDomain({ s: '😀', a: [{ b: null }] })).toBe(true)
  })
})

describe('buildDelegatedEventV5', () => {
  const draft = { id: C1, state: 'DRAFTING', dod: ['test'], performed_by: 'creator', earner_user_id: OWNER }
  it('the outer canonical matches the vector tests/sql/delegated_append.sh pins for private.v5_outer_canonical', () => {
    const built = buildEventCanonicalV5({
      hash_version: 5, id: '11111111-2222-4333-8444-555555555555', type: 'payment.acknowledged', contract_id: C1,
      actor_id: OWNER, dod_hash: '2'.repeat(64), created_at: '2026-11-24T12:00:00.123Z', prev_event_hash: 'GENESIS',
      payload_hash: '1'.repeat(64), agreement_hash: null, credential_id: GRANT, issuer_kind: 'owner_account',
    })
    expect(built.canonical).toBe('{"domain":"trustflow.event","hash_version":5,"id":"11111111-2222-4333-8444-555555555555",'
      + '"type":"payment.acknowledged","contract_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",'
      + '"actor_id":"11111111-1111-4111-8111-111111111111","dod_hash":"' + '2'.repeat(64) + '",'
      + '"created_at":"2026-11-24T12:00:00.123Z","prev_hash":"GENESIS","payload_hash":"' + '1'.repeat(64) + '",'
      + '"agreement_hash":null,"credential_id":"cccccccc-0000-4000-8000-000000000001","issuer_kind":"owner_account"}')
  })
  it('a draft proposal: explicit null agreement evidence, the exact RPC keys, and a v5 hash that verifies', async () => {
    const tree = finalRecordedTree({ note: 'paid' }, 'creator')
    const p = await buildDelegatedEventV5({
      type: 'payment.acknowledged', contract: draft, ownerId: OWNER, credentialId: GRANT, issuerKind: 'owner_account',
      tree, prevEventHash: null, idempotencyKey: 'k1', acceptedVersion: null,
    })
    expect(Object.keys(p.event).sort()).toEqual(['actor_id', 'agreement_hash', 'contract_id', 'created_at', 'dod_hash',
      'event_hash', 'id', 'idempotency_key', 'payload', 'payload_hash', 'prev_event_hash', 'type'])
    expect(p.event.agreement_hash).toBeNull()
    expect(p.hashedInputs).toEqual({ dod: ['test'], agreement: null })
    expect(p.event.prev_event_hash).toBe('GENESIS')
    expect(p.performedBy).toBe('creator')
    expect(p.event.payload).toBe(tree)
    const verdict = await verifyEventHashV5({ ...p.event, hash_version: 5, credential_id: GRANT, issuer_kind: 'owner_account' },
      p.event.event_hash)
    expect(verdict.verdict).toBe('match')
  })
  it('an accepted deal binds the v1 snapshot it hashed, for SQL to compare', async () => {
    const accepted = { ...draft, state: 'TERMS_ACCEPTED', project_name: 'p', amount_minor: 1, currency: 'JPY',
      deadline: '2026-12-01', earner_display_name: 'Owner', performed_by: 'counterparty' }
    const p = await buildDelegatedEventV5({
      type: 'payment.reported', contract: accepted, ownerId: OWNER, credentialId: GRANT, issuerKind: 'owner_account',
      tree: finalRecordedTree({}, 'counterparty'), prevEventHash: 'f'.repeat(64), idempotencyKey: null, acceptedVersion: 1,
    })
    expect(p.event.agreement_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(p.hashedInputs.agreement).toEqual({ snapshot_version: 1, project_name: 'p', dod: ['test'], amount: 1,
      currency: 'JPY', deadline: '2026-12-01', performed_by: 'counterparty', offered_by: 'Owner' })
    expect(p.performedBy).toBe('counterparty')
  })
})
