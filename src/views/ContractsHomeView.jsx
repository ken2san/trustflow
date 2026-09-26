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
import { Plus, Copy, ChevronDown, ChevronRight, Loader2, RefreshCw, AlertTriangle, LogIn } from 'lucide-react';
import {
  groupContracts, nextActionFor, statusLabel, formatAmount, formatDeadline,
} from '../lib/contractStatus.js';

function StatusDot({ owner }) {
  const tone = owner === 'you' ? 'bg-amber-400'
    : owner === 'client' ? 'bg-indigo-400'
    : 'bg-slate-600';
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${tone}`} />;
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
function LeadContractCard({ contract, onOpen, onCopyInvite }) {
  const action = nextActionFor(contract);
  const deadline = formatDeadline(contract);
  const canReshare = Boolean(contract.invite_token) && !contract.invite_token_used_at;

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
        <p className="text-sm text-slate-500">
          {formatAmount(contract)}
          {deadline && <> · due {deadline}</>}
        </p>
      </div>

      <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 space-y-1">
        <p className="text-white font-bold text-sm">{action.label}</p>
        {action.detail && <p className="text-xs text-slate-500">{action.detail}</p>}
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
      </div>
    </div>
  );
}

/** A single compact line. Everything that isn't the lead contract. */
function ContractRow({ contract, onOpen }) {
  const action = nextActionFor(contract);
  const deadline = formatDeadline(contract);

  return (
    <button
      onClick={() => onOpen(contract)}
      className="w-full text-left rounded-2xl border border-white/5 bg-white/[0.02] px-5 py-4 hover:bg-white/[0.05] hover:border-white/10 transition-all group"
    >
      <div className="flex items-center gap-3">
        <StatusDot owner={action.owner} />
        <span className="font-bold text-white text-sm truncate">
          {contract.project_name || 'Untitled agreement'}
        </span>
        <ChevronRight className="w-4 h-4 text-slate-600 ml-auto shrink-0 group-hover:text-slate-400 transition-colors" />
      </div>
      <div className="pl-5 mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
        {/* The state the server holds, then what it means for you. Both come
            from contracts.state; neither is derived from the flow screen's
            local step counter. */}
        <span className="text-slate-400">{statusLabel(contract)}</span>
        <span className="text-slate-700">·</span>
        <span><Counterparty contract={contract} /></span>
        <span className="text-slate-700">·</span>
        <span>{formatAmount(contract)}</span>
        {deadline && <><span className="text-slate-700">·</span><span>due {deadline}</span></>}
        <span className="text-slate-700">·</span>
        <span className={action.owner === 'you' ? 'text-amber-400/80' : 'text-slate-500'}>{action.label}</span>
      </div>
    </button>
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
  authStatus = 'anonymous', authEmail = null, onSignIn,
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
          <p className="text-xs text-slate-500">{error}</p>
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
          "no contracts yet" would be both wrong and alarming. */}
      {!loading && !error && !hasAny && authStatus === 'expired' && (
        <div className="rounded-[28px] border border-amber-500/20 bg-amber-500/[0.04] px-6 py-10 text-center space-y-3">
          <p className="text-white font-bold">You are signed out.</p>
          <p className="text-sm text-slate-400 max-w-sm mx-auto">
            Your contracts are still there{authEmail ? <> under <span className="text-slate-200">{authEmail}</span></> : null}.
            Sign in again to see them.
          </p>
          <button
            onClick={onSignIn}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white text-[#020617] font-black text-sm hover:bg-indigo-400 hover:text-white transition-all mt-2"
          >
            <LogIn className="w-4 h-4" /> Sign in
          </button>
        </div>
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
              <LeadContractCard contract={lead} onOpen={onOpenContract} onCopyInvite={onCopyInvite} />
              {restNeedsYou.map(c => (
                <ContractRow key={c.id} contract={c} onOpen={onOpenContract} />
              ))}
            </Section>
          )}

          <Section title="In progress" count={inProgress.length}>
            <div className="space-y-2">
              {inProgress.map(c => <ContractRow key={c.id} contract={c} onOpen={onOpenContract} />)}
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
                  {completed.map(c => <ContractRow key={c.id} contract={c} onOpen={onOpenContract} />)}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
