// The event rows AgreementView renders, from either source. The owner reads raw
// rows from PostgREST under the party-scoped SELECT policy; the guest gets an
// already-shaped response from guest-contract-events. These normalise both into
// one shape so one component serves both rather than two screens drifting
// apart. Moved out of App.jsx (Task 97) so the mapping itself can be tested.
//
// Who wrote a row is named only with server-recorded, per-event provenance,
// and no event carries any today: every row reads "a party", the owner's own
// acts included. See SERVER_RECORDED_PROVENANCE in contractStatus.js for why,
// and what would restore names. No provenance argument is passed below — on
// purpose, so a field appearing in the data cannot name anyone unreviewed.

import { claimantOfActorId, claimantOfShapedActor } from './contractStatus.js';

const byLine = claimant => `by ${claimant ?? 'a party'}`;

/**
 * Raw `events` rows, as the contract's owner reads them. `viewerUserId` is the
 * signed-in user: once provenance exists, "you" is said only for that id.
 */
export function shapeOwnerEvents(rows, contract, viewerUserId) {
  const performerIsCreator = (contract.performed_by ?? 'creator') === 'creator';
  return [...(rows ?? [])]
    .filter(ev => ev.type !== 'runtime.snapshot')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(ev => {
      const claimant = claimantOfActorId(ev.actor_id, viewerUserId);
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

/** One event from guest-contract-events, which describes its actor. */
export function shapeGuestEvent(ev) {
  const claimant = claimantOfShapedActor(ev?.actor);
  return {
    id: ev?.id,
    type: ev?.type,
    created_at: ev?.created_at,
    actorLabel: byLine(claimant),
    claimant,
    reason: ev?.payload?.reason ?? ev?.payload?.note ?? null,
  };
}
