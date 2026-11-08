// src/views/ContractsHomeView.jsx
//
// The home screen: your contracts, ordered by what needs you.
//
// This replaces a marketplace-first home whose primary content was two
// hardcoded fixture jobs, and where creating a contract with a client you
// already have was a small text link below them. The contract you are actually
// working on is now the first thing on the screen.
//
// Status comes from contracts.state via contractStatus.js. Nothing here reads
// the contract flow screen's local 1–5 step counter; that screen still owns its
// own progression and is untouched for now.

import React from 'react';
import { Plus, Copy, ChevronDown, ChevronRight, Loader2, RefreshCw, AlertTriangle, LogIn, Trash2 } from 'lucide-react';
import {
  groupContracts, nextActionFor, statusLabel, formatAmount, clocksFor, sinceText, CLOCKS,
} from '../lib/contractStatus.js';

function StatusDot({ owner }) {
  const tone = owner === 'you' ? 'bg-amber-400'
    : owner === 'client' ? 'bg-indigo-400'
    : 'bg-slate-600';
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${tone}`} />;
}

/**
 * The clocks that apply, each named for what it is.
 *
 * Three different dates could all be called "expires" here and only one of
 * them — the deadline — is part of what was agreed. They are labelled rather
 * than merged, because a reader who cannot tell them apart will assume the
 * agreement lapses when a link does.
 *
 * `only` keeps the compact row short: it shows the agreed deadline always, and
 * a credential clock only once it is close enough to be someone's problem. The
 * full set is on the lead card and the agreement screen.
 */
function Clocks({ contract, only = 'all' }) {
  const clocks = clocksFor(contract)
    .filter(c => only === 'all' || c.kind === CLOCKS.DEADLINE || c.status !== 'ok');
  if (!clocks.length) return null;
  // Each value is one unbreakable span, and the separator between values is
  // the parent's gap rather than a "·" of its own. Both halves of that are
  // about wrapping: "123 days late" broke between "123" and "days late" at
  // phone width, and a free-standing "·" in a flex-wrap row lands at the end
  // or the start of a line as often as between two things (blind review of
  // the 2026-11-08 captures).
  return clocks.map((clock) => {
    const tone = clock.status === 'passed' ? 'text-amber-400/80'
      : clock.status === 'soon' ? 'text-amber-400/60' : undefined;
    return (
      <React.Fragment key={clock.kind}>
        <span className={`whitespace-nowrap ${tone ?? ''}`}>{clock.label} {clock.on}</span>
        {clock.text && <span className={`whitespace-nowrap ${tone ?? ''}`}>{clock.text}</span>}
      </React.Fragment>
    );
  });
}

function Counterparty({ contract }) {
  // The address that actually accepted, when there is one; otherwise the one
  // the invite was addressed to. These are separate fields on purpose and the
  // distinction is worth keeping visible.
  const accepted = contract.hirer_email;
  const invited = contract.invited_hirer_email;
  if (accepted) return <>{accepted}</>;
  if (invited) return <>{invited} <span className="text-slate-600">(invited)</span></>;
  return <span className="text-slate-600">No client yet</span>;
}

/** The expanded row: the one contract most in need of attention. */
function LeadContractCard({ contract, onOpen, onCopyInvite, onDeleteDraft }) {
  const action = nextActionFor(contract);
  const canReshare = Boolean(contract.invite_token) && !contract.invite_token_used_at;
  const canDelete = canReshare && Boolean(onDeleteDraft);
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="rounded-[28px] border border-white/10 bg-[#0f172a]/60 p-6 sm:p-7 space-y-5 shadow-xl backdrop-blur-xl">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
          <StatusDot owner={action.owner} />
          {statusLabel(contract)}
        </div>
        <button
          onClick={() => onOpen(contract)}
          className="block text-left text-2xl font-black tracking-tight text-white hover:text-indigo-300 transition-colors"
        >
          {contract.project_name || 'Untitled agreement'}
        </button>
        <p className="text-sm text-slate-400"><Counterparty contract={contract} /></p>
        <p className="flex flex-wrap gap-x-3 text-sm text-slate-500">
          <span className="whitespace-nowrap">{formatAmount(contract)}</span>
          <Clocks contract={contract} />
        </p>
      </div>

      <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 space-y-1">
        <p className="text-white font-bold text-sm">{action.label}</p>
        {action.detail && <p className="text-xs text-slate-500">{action.detail}</p>}
        {/* When this wait started, from the stamp the chain already holds. A
            missing stamp renders nothing rather than "since now". */}
        {sinceText(action.since) && (
          <p className="text-xs text-slate-500">{sinceText(action.since)}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => onOpen(contract)}
          className="px-5 py-2.5 rounded-2xl bg-white text-[#020617] font-black text-sm hover:bg-indigo-400 hover:text-white transition-all"
        >
          Open
        </button>
        {canReshare && (
          <button
            onClick={() => onCopyInvite(contract)}
            className="px-5 py-2.5 rounded-2xl border border-white/10 text-slate-300 font-bold text-sm hover:bg-white/5 hover:text-white transition-all flex items-center gap-2"
          >
            <Copy className="w-3.5 h-3.5" /> Copy invite link
          </button>
        )}
        {canDelete && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="px-5 py-2.5 rounded-2xl border border-white/10 text-slate-500 font-bold text-sm hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/20 transition-all flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete draft
          </button>
        )}
        {canDelete && confirming && (
          <div className="flex items-center gap-3 px-1">
            <span className="text-xs text-slate-500">Delete this draft?</span>
            <button
              onClick={() => { setConfirming(false); onDeleteDraft(contract); }}
              className="text-xs font-black uppercase tracking-widest text-rose-400 hover:text-rose-300"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300"
            >
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A single compact line. Everything that isn't the lead contract. */
function ContractRow({ contract, onOpen, onCopyInvite, onDeleteDraft }) {
  const action = nextActionFor(contract);
  // An invite that exists and has never been consumed: nobody has accepted
  // yet, so there's still a link worth resending and still a draft worth
  // being able to remove. The lead card had "Copy invite link" for this same
  // condition; this compact row — where most awaiting-acceptance contracts
  // actually land, since "needs you" is for your own turn, not the client's —
  // never had it at all.
  const canReshare = Boolean(contract.invite_token) && !contract.invite_token_used_at;
  const canDelete = canReshare && onDeleteDraft;
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="w-full rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 hover:bg-white/[0.05] hover:border-white/10 transition-all group">
      <div className="flex items-center gap-3">
        <button onClick={() => onOpen(contract)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <StatusDot owner={action.owner} />
          <span className="font-bold text-white text-sm line-clamp-2">
            {contract.project_name || 'Untitled agreement'}
          </span>
        </button>
        {canDelete && confirming ? (
          /* The question is a label and the answers are the buttons, the same
             way the lead card asks it. This row used to use "Delete?" itself
             as the confirming button with only "No" beside it, which reads as
             a prompt whose single answer is No — so the row sat in this state
             and nothing was ever deleted. */
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Delete?</span>
            <button
              onClick={() => { setConfirming(false); onDeleteDraft(contract); }}
              className="text-[10px] font-black uppercase tracking-widest text-rose-400 hover:text-rose-300"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300"
            >
              No
            </button>
          </div>
        ) : (
          <>
            {canReshare && onCopyInvite && (
              <button
                onClick={() => onCopyInvite(contract)}
                title="Copy invite link"
                className="p-1.5 text-slate-600 hover:text-indigo-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setConfirming(true)}
                title="Delete this draft"
                className="p-1.5 text-slate-600 hover:text-rose-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => onOpen(contract)} className="shrink-0">
              <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors" />
            </button>
          </>
        )}
      </div>
      <button onClick={() => onOpen(contract)} className="pl-5 mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500 text-left w-full">
        {/* The state the server holds, then what it means for you. Both come
            from contracts.state; neither is derived from the flow screen's
            local step counter.

            Separated by the row's own gap, not by "·" spans. This line wraps
            onto three lines at phone width with a long address in it, and a
            separator that is its own flex item wraps independently of both
            things it separates — the captures of 2026-11-08 show one ending a
            line and another starting one. */}
        <span className="text-slate-400 whitespace-nowrap">{statusLabel(contract)}</span>
        <span><Counterparty contract={contract} /></span>
        <span className="whitespace-nowrap">{formatAmount(contract)}</span>
        <Clocks contract={contract} only="actionable" />
        <span className={action.owner === 'you' ? 'text-amber-400/80' : 'text-slate-500'}>
          {action.label}{sinceText(action.since) && <span className="text-slate-500 whitespace-nowrap"> · {sinceText(action.since).toLowerCase()}</span>}
        </span>
      </button>
    </div>
  );
}

function Section({ title, count, children }) {
  if (!count) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-600">
        {title} <span className="text-slate-700">({count})</span>
      </h2>
      {children}
    </section>
  );
}

export default function ContractsHomeView({
  contracts, loading, error, onOpenContract, onNewContract, onCopyInvite, onRetry,
  authStatus = 'anonymous', authEmail = null, onSignIn, onDeleteDraft,
  // Agreements this browser accepted as an invited counterparty. They are not
  // `contracts` — a guest has no account and RLS returns them nothing — so
  // they arrive as bare ids from localStorage and are offered, not listed.
  guestAgreements = [], onOpenGuestAgreement,
}) {
  const [showCompleted, setShowCompleted] = React.useState(false);
  const { needsYou, inProgress, completed } = React.useMemo(
    () => groupContracts(contracts ?? []), [contracts],
  );

  // The single most urgent contract is expanded in place. This avoids a
  // separate "next action" card that would restate what the list already says
  // and could disagree with it the moment a state changes.
  const [lead, ...restNeedsYou] = needsYou;

  const hasAny = (contracts?.length ?? 0) > 0;

  return (
    <div className="max-w-2xl mx-auto py-10 space-y-10 animate-fade-in-up">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-black tracking-tighter text-white">Contracts</h1>
        <button
          onClick={onNewContract}
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm transition-all shadow-lg"
        >
          <Plus className="w-4 h-4" /> New contract
        </button>
      </header>

      {loading && (
        <div className="flex items-center gap-3 text-slate-500 text-sm py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your contracts…
        </div>
      )}

      {!loading && error && (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-5 py-4 space-y-2">
          <p className="text-amber-400 text-sm font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Your contracts could not be loaded.
          </p>
          {/* Verbatim, and labelled as not addressed to the reader. This
              project lost two weeks to a client that collapsed the server's
              reason into one word, so the text stays exactly as the server
              sent it; what changes is that a PostgREST string no longer reads
              as advice to the person looking at it. */}
          <p className="text-xs text-slate-500">
            Technical detail: <span className="font-mono text-slate-400 break-words">{error}</span>
          </p>
          {onRetry && (
            <button onClick={onRetry} className="text-xs text-slate-400 hover:text-white underline flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3" /> Try again
            </button>
          )}
        </div>
      )}

      {/* An empty list means two very different things. Someone who has never
          made a contract should be invited to make one; someone whose session
          lapsed is looking at work they think they have lost, and telling them
          "no contracts yet" would be both wrong and alarming.

          What this may NOT do is promise the work is there. The address below
          comes from localStorage, not from the server — nothing here has asked
          whether that account still exists or what it holds. This said "Your
          contracts are still there … nothing has been lost" and then, one
          click later, the sign-in screen said no account was found for that
          address. An account deleted out from under a browser reaches exactly
          that state, and a product whose whole claim is a record worth
          trusting cannot be the thing that says records are safe without
          having looked. So: what this browser remembers, and what signing in
          would do — reassurance that is true without a round trip. */}
      {!loading && !error && !hasAny && authStatus === 'expired' && (
        <div className="rounded-[28px] border border-amber-500/20 bg-amber-500/[0.04] px-6 py-10 text-center space-y-3">
          <p className="text-white font-bold">You are signed out.</p>
          <p className="text-sm text-slate-400 max-w-sm mx-auto">
            This browser was last signed in{authEmail ? <> as <span className="text-slate-200">{authEmail}</span></> : null}.
            Sign in again to see whatever is saved under that address — signing out removes nothing.
          </p>
          <button
            onClick={onSignIn}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white text-[#020617] font-black text-sm hover:bg-indigo-400 hover:text-white transition-all mt-2"
          >
            <LogIn className="w-4 h-4" /> Sign in
          </button>
        </div>
      )}

      {/* An invited counterparty has no account and therefore no list: every
          query above returns them nothing, and before this block the only
          route back to an agreement they had accepted was the original invite
          link — which by then says "already accepted" and points at an access
          link that is never issued. Their credential was in this browser the
          whole time, for ninety days, with nothing able to ask for it.

          Offered rather than listed, because the id is all that is kept. The
          title, the amount and whether the token still works are the server's
          to answer, and it answers when one is opened. */}
      {guestAgreements.length > 0 && onOpenGuestAgreement && (
        <section className="rounded-[28px] border border-white/5 bg-white/[0.02] px-6 py-5 space-y-3">
          <h3 className="text-[11px] font-black tracking-[0.2em] text-slate-400 uppercase">
            Accepted on this device
          </h3>
          <p className="text-xs text-slate-400">
            Agreements you joined by invitation. This list is built from the
            access this browser kept — the records themselves live on the
            server. On another browser, ask whoever invited you to re-send
            your access link.
          </p>
          <ul className="space-y-2">
            {/* Named, not numbered. Three entries reading "Open the agreement
                you accepted" above three uuids left a counterparty unable to
                tell which was the one they had just joined (2026-11-06). The
                name is remembered at acceptance; an entry that predates that,
                or whose label was lost, falls back to the id rather than
                pretending to know. */}
            {guestAgreements.map(({ id, label }) => (
              <li key={id}>
                <button
                  onClick={() => onOpenGuestAgreement(id)}
                  className="w-full text-left px-4 py-3 rounded-2xl border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all"
                >
                  <span className="text-sm font-bold text-slate-200">
                    {label || 'An agreement you accepted'}
                  </span>
                  <span className="block text-[11px] text-slate-500 font-mono pt-0.5">{id}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* No button here: the header above already offers "New contract" and is
          always on screen, so a second one in this empty state was the same
          action twice with nothing between them. */}
      {!loading && !error && !hasAny && authStatus !== 'expired' && (
        <div className="rounded-[28px] border border-white/5 bg-white/[0.02] px-6 py-12 text-center space-y-3">
          <p className="text-white font-bold">No contracts yet.</p>
          <p className="text-sm text-slate-500 max-w-sm mx-auto">
            Already working with someone? Use "New contract" above and send them an invite —
            what you both agreed to gets recorded from day one.
          </p>
          {authStatus === 'anonymous' && onSignIn && (
            <p className="text-xs text-slate-600 pt-2">
              Already set one up on another device?{' '}
              <button onClick={onSignIn} className="text-indigo-400 hover:text-white underline underline-offset-4 transition-colors">
                Sign in
              </button>
            </p>
          )}
        </div>
      )}

      {!loading && !error && hasAny && (
        <>
          {lead && (
            <Section title="Needs you" count={needsYou.length}>
              <LeadContractCard contract={lead} onOpen={onOpenContract} onCopyInvite={onCopyInvite} onDeleteDraft={onDeleteDraft} />
              {restNeedsYou.map(c => (
                <ContractRow key={c.id} contract={c} onOpen={onOpenContract} onCopyInvite={onCopyInvite} onDeleteDraft={onDeleteDraft} />
              ))}
            </Section>
          )}

          <Section title="In progress" count={inProgress.length}>
            <div className="space-y-2">
              {inProgress.map(c => <ContractRow key={c.id} contract={c} onOpen={onOpenContract} onCopyInvite={onCopyInvite} onDeleteDraft={onDeleteDraft} />)}
            </div>
          </Section>

          {completed.length > 0 && (
            <section className="space-y-3 border-t border-white/5 pt-6">
              <button
                onClick={() => setShowCompleted(v => !v)}
                className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.25em] text-slate-600 hover:text-slate-400 transition-colors"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showCompleted ? '' : '-rotate-90'}`} />
                Completed <span className="text-slate-700">({completed.length})</span>
              </button>
              {showCompleted && (
                <div className="space-y-2">
                  {completed.map(c => <ContractRow key={c.id} contract={c} onOpen={onOpenContract} onCopyInvite={onCopyInvite} onDeleteDraft={onDeleteDraft} />)}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
