// The event rows AgreementView renders, from either source. The owner reads raw
// rows from PostgREST under the party-scoped SELECT policy; the guest gets an
// already-shaped response from guest-contract-events. These normalise both into
// one shape so one component serves both rather than two screens drifting
// apart. Moved out of App.jsx (Task 97) so the mapping itself can be tested.
//
// Who wrote a row is named only when that is provable: a server-attested row
// whose actor is the signed-in viewer ("you"), the guest, or (for a guest
// reader) the earner.
// Anything else — a legacy browser-written row, an unknown actor, a missing
// one — reads "a party" (Codex Tasks 93, 94).

import { claimantOfActorId, claimantOfShapedActor } from './contractStatus.js';

const byLine = claimant => `by ${claimant ?? 'a party'}`;

/**
 * Raw `events` rows, as the contract's owner reads them. `viewerUserId` is the
 * signed-in user: "you" is said only for that id, never for the contract's
 * earner as such (the owner list does not even select earner_user_id, and a
 * party who reads a contract is not necessarily its earner).
 */
export function shapeOwnerEvents(rows, contract, viewerUserId) {
  const performerIsCreator = (contract.performed_by ?? 'creator') === 'creator';
  return [...(rows ?? [])]
    .filter(ev => ev.type !== 'runtime.snapshot')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(ev => {
      const claimant = claimantOfActorId(ev.actor_id, viewerUserId, ev.hash_version);
      return {
        id: ev.id,
        type: ev.type,
        created_at: ev.created_at,
        actorLabel: byLine(claimant),
        claimant,
        reason: ev.payload?.reason ?? ev.payload?.note ?? null,
        _performerIsCreator: performerIsCreator,
      };
    });
}

/** One event from guest-contract-events, which already names its actor. */
export function shapeGuestEvent(ev) {
  const claimant = claimantOfShapedActor(ev?.actor, ev?.integrity?.trust_model);
  return {
    id: ev?.id,
    type: ev?.type,
    created_at: ev?.created_at,
    actorLabel: byLine(claimant),
    claimant,
    reason: ev?.payload?.reason ?? ev?.payload?.note ?? null,
  };
}
