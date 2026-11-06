// src/views/GuestEvidenceView.jsx
// The guest Hirer's view of the evidence trail for the contract they accepted.
//
// Everything rendered here comes from the guest-contract-events Edge Function,
// which resolves the contract from the guest credential alone and returns a
// shaped subset — not raw event rows. This component does no verification of
// its own; it reports what the server verified, and is deliberate about not
// overstating it (see the footnote about payload coverage).

import { ShieldCheck, ShieldAlert, Clock, AlertTriangle, Download } from 'lucide-react';

const TYPE_LABELS = {
  'contract.initiated':   'Agreement created',
  'contract.accepted':    'Agreement accepted',
  // Phrased as what a party said, not as what happened: TrustFlow attests the
  // statement, not the delivery.
  'performance.asserted': 'Delivery reported by the other party',
  'performance.accepted': 'You confirmed the delivery',
  'performance.rejected': 'You reported the delivery as incomplete',
  // Retired names, still present on older records.
  'work.submitted':       'Work submitted',
  'work.approved':        'Work approved',
  'work.rejected':        'Work rejected',
  'contract.cancelled':   'Agreement cancelled',
  'contract.completed':   'Agreement completed',
  'dod.consent_recorded': 'Terms accepted',
  'dispute.opened':       'Dispute opened',
  'rating.submitted':     'Rating submitted',
  // A party's claim about payment made outside TrustFlow, not a verified fact.
  'payment.reported':     'Payment reported sent',
  'payment.acknowledged': 'Payment confirmed received',
  'payment.disputed':     'Payment reported as not received',
};

// Human names for the agreed terms. The snapshot's own key names are a wire
// format; a reader should not have to learn them.
const TERM_LABELS = {
  project_name: 'what is being done',
  dod:          'what counts as finished',
  amount:       'the amount',
  currency:     'the currency',
  deadline:     'the deadline',
  performed_by: 'which side does the work',
  offered_by:   'who offered it',
};

function formatAmount(amount, currency) {
  if (amount === null || amount === undefined) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency ?? 'JPY', maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

/**
 * Turn an accepted agreement snapshot into label/value rows.
 *
 * Deliberately no hashes and no version numbers: this is the record a person
 * reads to know what they agreed to, not a verification report.
 */
function describeAgreement(agreement) {
  const rows = [];
  if (agreement.project_name) rows.push(['What', agreement.project_name]);
  const dod = Array.isArray(agreement.dod) ? agreement.dod : [];
  if (dod.length > 0) {
    rows.push(['Done when', (
      <ul className="space-y-0.5">
        {dod.map((item, i) => (
          <li key={i}>· {typeof item === 'string' ? item : (item?.text ?? JSON.stringify(item))}</li>
        ))}
      </ul>
    )]);
  }
  const amount = formatAmount(agreement.amount, agreement.currency);
  if (amount) rows.push(['Amount', amount]);
  if (agreement.deadline) rows.push(['By', formatDay(agreement.deadline)]);
  // Stated in plain terms rather than echoing the stored value: the snapshot
  // says "counterparty", which means the person reading this page.
  if (agreement.performed_by) {
    rows.push(['Performed by',
      agreement.performed_by === 'counterparty' ? 'You' : (agreement.offered_by ?? 'The other party')]);
  }
  return rows;
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** A date as the invitation writes it, so one fact has one spelling. */
function formatDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Field names a reader should not have to decode.
 *
 * The record printed `counterparty_name` — a column name — beside the value,
 * on the one screen meant to be legible to someone who has never used this
 * product. Unlisted keys are humanised rather than hidden: an unknown field is
 * still evidence, and dropping it would quietly narrow the record.
 */
const PAYLOAD_LABELS = {
  counterparty_name: 'Name given when accepting',
  note: 'Note',
  reason: 'Reason given',
  amount: 'Amount',
};

const humanise = (key) => key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function EventRow({ event }) {
  const attested = event.integrity.trust_model === 'server_attested';
  // Only false is a problem. null means the row carries nothing to check,
  // which is a different statement from "the check failed".
  const broken = event.integrity.hash_valid === false || event.integrity.chain_linked === false;

  return (
    <li className="relative pl-8 pb-6 last:pb-0 border-l border-white/10 last:border-transparent">
      <span className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${
        broken ? 'bg-red-500' : attested ? 'bg-emerald-500' : 'bg-slate-500'
      }`} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-white font-bold text-sm">
          {TYPE_LABELS[event.type] ?? event.type}
        </span>
        <span className="text-[11px] text-slate-400 font-mono">{formatWhen(event.created_at)}</span>
      </div>

      <p className="text-xs text-slate-400 mt-1">
        by <span className="text-slate-300">{event.actor.label}</span>
        {/* The server already labels the viewer's own acts "You"; adding
            "(you)" to that produced "by You (you)". The suffix is for an act
            attributed to a named party that happens to be the reader. */}
        {event.actor.role === 'guest_hirer' && event.actor.label !== 'You'
          && <span className="text-slate-400"> (you)</span>}
      </p>

      {Object.keys(event.payload).length > 0 && (
        <dl className="mt-2 text-[11px] text-slate-400 space-y-0.5">
          {Object.entries(event.payload).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-slate-400">{PAYLOAD_LABELS[key] ?? humanise(key)}</dt>
              <dd className="text-slate-400">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className={`mt-2 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest ${
        broken ? 'text-red-400' : attested ? 'text-emerald-400' : 'text-amber-400'
      }`}>
        {broken
          ? <><ShieldAlert className="w-3 h-3" />Integrity check failed</>
          : attested
            ? <><ShieldCheck className="w-3 h-3" />Server-attested</>
            : <><AlertTriangle className="w-3 h-3" />Client-asserted</>}
      </p>
    </li>
  );
}

export default function GuestEvidenceView({ evidence, reason, onBack, onExport }) {
  if (reason) {
    const message = {
      no_credential:      'This browser does not hold a credential for the agreement.',
      invalid_guest_token:'This access link is no longer valid.',
      guest_token_expired:'This access link has expired.',
    }[reason] ?? 'The evidence trail could not be loaded.';

    return (
      <div className="max-w-lg mx-auto text-center space-y-4 py-20">
        <ShieldAlert className="w-10 h-10 text-slate-400 mx-auto" />
        <p className="text-slate-400 text-sm">{message}</p>
        {onBack && (
          <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-300 underline">
            Go back
          </button>
        )}
      </div>
    );
  }

  if (!evidence) {
    return (
      <div className="max-w-lg mx-auto text-center py-20 text-slate-400 text-sm">
        <Clock className="w-8 h-8 mx-auto mb-3 animate-pulse" />
        Loading the record…
      </div>
    );
  }

  const {
    contract, events, chain,
    accepted_agreement: accepted,
    acceptance_identity: identity,
    terms_changed_since_acceptance: changed,
  } = evidence;

  const changedTerms = (changed ?? []).map(key => TERM_LABELS[key] ?? key);
  const acceptedTerms = accepted ? describeAgreement(accepted) : [];

  return (
    <div className="max-w-2xl mx-auto py-12 space-y-8 animate-fade-in-up">
      <header className="space-y-2">
        <h2 className="text-3xl font-black tracking-tighter text-white">Record of agreement</h2>
        <p className="text-slate-400 text-sm">
          {contract.project_name} — with {contract.earner_display_name ?? 'your counterparty'}
        </p>
        {/* Two separate facts, kept separate. The invitation was addressed to
            one person; whoever held it gave a name when accepting. TrustFlow
            never checked that the two are the same person, so it does not say
            "accepted as", which reads as an established identity. */}
        {/* Readable, not de-emphasised. These two lines were text-xs on
            slate-700/slate-500 against a near-black panel — under 2:1, where
            4.5:1 is the floor — so the one fact a dispute turns on was the
            least legible thing on the page while an "acceptance recorded"
            toast was the brightest. A reader who cannot make out that the
            invited address and the accepting address differ is not being told
            the distinction the wording above was written to preserve. */}
        {identity ? (
          <dl className="text-sm text-slate-300 space-y-0.5 pt-1">
            {identity.invited_recipient && (
              <div className="flex gap-2">
                <dt className="text-slate-400">Invitation sent to</dt>
                <dd className="text-slate-200">{identity.invited_recipient}</dd>
              </div>
            )}
            {identity.claimed_identity && (
              <div className="flex gap-2">
                <dt className="text-slate-400">Accepted using that invitation, giving</dt>
                <dd className="text-slate-200">{identity.claimed_identity}</dd>
              </div>
            )}
          </dl>
        ) : (
          contract.hirer_email && (
            <p className="text-sm text-slate-300">
              Accepted using the invitation, giving {contract.hirer_email}
            </p>
          )
        )}
      </header>

      {/* The terms as recorded at acceptance — read from the acceptance event,
          never from the contract row, which may since have moved on. */}
      {accepted && (
        <section className="rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">
            What was accepted
          </h3>
          <dl className="text-sm space-y-1.5">
            {acceptedTerms.map(([label, value]) => (
              <div key={label} className="flex flex-wrap gap-x-3">
                <dt className="text-slate-400 text-xs w-32 shrink-0 pt-0.5">{label}</dt>
                <dd className="text-slate-300 flex-1">{value}</dd>
              </div>
            ))}
          </dl>
          {changedTerms.length > 0 && (
            <p className="text-[11px] text-amber-400/80 border-t border-white/5 pt-3 leading-relaxed">
              The live record of this agreement no longer matches what was accepted
              ({changedTerms.join(', ')}). The terms above are the ones the evidence proves.
            </p>
          )}
        </section>
      )}

      <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 text-xs space-y-1">
        <p className="text-slate-400">
          <span className="text-slate-400">{chain.event_count}</span> event{chain.event_count === 1 ? '' : 's'} recorded
          {chain.client_asserted > 0 && (
            <span className="text-amber-500/70">
              {' '}· {chain.client_asserted} predate server attestation
            </span>
          )}
        </p>
        <p className={chain.verified ? 'text-emerald-400' : 'text-slate-400'}>
          {chain.verified
            ? 'Hash chain verified across every server-attested event.'
            : 'No server-attested events to verify yet.'}
        </p>
      </div>

      {events.length === 0 ? (
        <p className="text-slate-400 text-sm">Nothing has been recorded on this agreement yet.</p>
      ) : (
        <ol className="ml-1">
          {events.map(event => <EventRow key={event.id} event={event} />)}
        </ol>
      )}

      <p className="text-[11px] text-slate-400 leading-relaxed border-t border-white/5 pt-4">
        Each event's hash covers its type, timing, actor and the agreement it belongs to, and links
        to the event before it.{' '}
        {/* Stated from what the server reported, not assumed: a record containing
            entries written before payloads were attested cannot claim otherwise. */}
        {chain.payload_covered_by_hash
          ? <>It also covers the detail fields shown under each entry, so those are tamper-evident too.</>
          : <>It does <span className="text-slate-400">not</span> cover the detail fields shown under
             each entry, so those are recorded but not tamper-evident.</>}
        {' '}TrustFlow records what each party stated; it does not establish that a statement is true.
        {chain.truncated && ' Only the earliest events are shown.'}
      </p>

      {/* The invitation promises the counterparty "your own copy of the
          record". It was true — the download sits on the agreement screen —
          but not from here, which is the screen reached by the link called
          "View the full verification detail" and the one a reader lands on
          when they go looking for it. A reviewer shown these screens with no
          repository looked for the promised file and reported it missing
          (blind review, 2026-11-05). A promise is kept where it is made. */}
      {onExport && (
        <div className="pt-2 space-y-2">
          <button
            onClick={onExport}
            className="flex items-center gap-2 px-5 py-3 rounded-2xl border border-white/10 hover:border-white/20 hover:bg-white/5 text-sm font-bold text-slate-200 transition-all"
          >
            <Download className="w-4 h-4" /> Download this record
          </button>
          {/* slate-400, not slate-500: at 12px the dimmer one measures 4.23:1
              against this background and the accessibility gate rejected it —
              on a screen whose last finding was exactly this. */}
          <p className="text-xs text-slate-400">
            A copy of what is shown here, as a file you keep. Reading it needs
            nothing from TrustFlow. It records what the server verified; it is
            not a document you can re-verify yourself.
          </p>
        </div>
      )}

      {onBack && (
        <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-300 underline">
          Go back
        </button>
      )}
    </div>
  );
}
