import { useEffect, useState } from "react";
import { ShieldCheck, ArrowRight, X, Download, Lock, CheckCircle2, User, AlertTriangle, Clock } from "lucide-react";

// Each of these says only what the system does. The three cards here used to
// promise a Trust Passport that builds over time, records "you own
// permanently", and an agreement locked "before any money moves" — none of
// which this product has: the reputation layer was removed (Decisions.md,
// 2026-11-05), a guest holds a link rather than an account, and money moves
// outside TrustFlow entirely. This is the counterparty's first screen and the
// first thing it does is make claims, so it is the last place to overstate.
const GAINS = [
  {
    icon: ShieldCheck,
    // "recorded, not remembered" was the first line a blind counterparty hit
    // and it reported not understanding it (2026-11-06). It was a writer's
    // phrase: the contrast it draws is with someone's memory of a verbal
    // agreement, which nobody on this screen is thinking about yet.
    title: "What you agree to is written down, and cannot be changed quietly.",
    // "cannot pass as the original" was too strong and Codex's audit said so:
    // the chain makes a later edit DETECTABLE when the record is checked, and
    // UPDATE/DELETE on events is revoked, but there is no third-party
    // timestamp and no TSA token is written, so nothing here outranks the
    // operator of the server. Scoped to detection, which is what the code does
    // (log-event/index.ts:280-318, 20260927000000_agreement_snapshot.sql:48-75,
    // 20260313000000_events_table.sql:129-133).
    body: "Accepting writes down these exact terms, with the time — the amount, the deadline and what counts as done. Every step after it is locked to the one before, so if anyone edits the record later, the change shows up when it is checked.",
  },
  {
    icon: Download,
    title: "You get your own copy of the record.",
    // "Everything recorded" was OVERSTATED (Codex audit, 2026-11-05):
    // guest-contract-events returns at most 500 events, oldest first, and sets
    // a `truncated` flag that the screen and the exported file both carry. Not
    // a silent loss, but not everything either, so the number is stated.
    body: "What is recorded against this agreement — up to the most recent 500 entries, and the file says so if there are more — downloadable as a file that is yours to keep. No account needed, and reading it does not depend on TrustFlow still being here.",
  },
  {
    icon: Lock,
    title: "What \"done\" means is fixed before the work starts.",
    body: "The completion criteria are part of what you are accepting, so neither side can quietly revise them later. Payment happens on whatever rail you both already use — TrustFlow records that it was reported, it does not hold the money.",
  },
];

// Stage 1: read-only review. Stage 2: identity + explicit consent. onAccept fires after consent.
const InviteView = ({ inviteData, tokenError, onAccept, onDecline }) => {
  // Hooks must be declared before any conditional return
  const [stage, setStage] = useState('review'); // 'review' | 'identify'
  const [displayName, setDisplayName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

  // Each stage is a new screen on one scrolled page, so without this the
  // second one opens at the first one's scroll offset. At phone width that put
  // "How should we address you?" behind the fixed header — the heading of the
  // screen asking for consent, unreadable, which is how the blind review of
  // 2026-11-05 met it.
  useEffect(() => { window.scrollTo({ top: 0 }); }, [stage]);


  // Token error states (expired, tampered, malformed)
  if (tokenError || !inviteData) {
    const isExpired = tokenError === 'expired';
    // The server refuses an acceptance whose contract row changed after this
    // screen loaded (row_version, 20260928000000_atomic_acceptance.sql). That
    // is the one failure here that is nobody's mistake, and calling it an
    // invalid link told the reader their link was broken when the terms had
    // simply moved under them.
    const termsChanged = tokenError === 'terms_changed';
    // Distinct from the rest: the invitation worked, once. Telling someone
    // their link "did not work" when they are the one who used it sends them
    // back to the sender for a replacement nobody should issue.
    const alreadyUsed = tokenError === 'already_used';
    // The server could not check the terms against what this page showed,
    // because the two were built at different times. Nothing is wrong with the
    // agreement, so it must not be described as if something were.
    const cannotCheck = tokenError === 'terms_check_unsupported';
    const Icon = isExpired ? Clock : AlertTriangle;
    const title = isExpired ? 'This invite has expired.'
      : termsChanged ? 'The terms changed while you were reading.'
      : cannotCheck ? 'This page is out of date.'
      : alreadyUsed ? 'This invitation has already been accepted.'
      : 'Invalid invite link.';
    const body = isExpired
      ? 'Invite links are valid for 72 hours. Ask whoever sent you this link to issue a new one — they can do it from their own copy of the agreement.'
      // Deliberately lists the possibilities rather than guessing: the server
      // returns the same refusal for a link that was mistyped, already used,
      // or deleted before it was opened, and telling a stranger it was
      // "modified" when they simply pasted it twice is both wrong and alarming.
      : alreadyUsed
      // Said "reachable from the access link you were given when you accepted".
      // No such link is given — accepting shows a screen, not a URL — so the
      // sentence sent a guest looking for something that does not exist. A
      // blind counterparty did exactly that and could not tell whether its own
      // record was lost (2026-11-06). The route that does exist is the device
      // that accepted, which keeps the credential; the one that exists when
      // that device is gone is a re-issue by the sender.
      // "it keeps your access and lists the agreement" promised something the
      // storage can fail at silently (guestSession.js swallows a write
      // failure), so it is conditional now. Codex, 2026-11-06.
      ? 'An invitation can only be accepted once. If that was you, open this site on the browser you accepted in — if it still holds your access, the agreement is listed there. If it does not, or you are on another device, ask whoever invited you to re-send your access link. If it was not you, say so to them before anything else happens.'
      : cannotCheck
      ? 'Nothing was accepted, and nothing is wrong with the agreement. This page was loaded from an older version of TrustFlow than the one now running, so it could not confirm that the terms on screen are still the terms on offer. Reload the page and read them again.'
      : termsChanged
      ? 'Nothing was accepted. Whoever sent this invitation edited the agreement after this page loaded, so the terms on screen are no longer the ones on offer. Open the link again to see the current terms before you decide.'
      : 'This link did not work. It may have been mistyped or cut short when it was copied, already used, or withdrawn by the sender. Ask whoever sent it to you for a new one.';
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 max-w-md mx-auto text-center animate-fade-in-up">
        <div className="w-16 h-16 bg-amber-500/10 border border-amber-500/20 rounded-[20px] flex items-center justify-center">
          <Icon className="w-8 h-8 text-amber-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-black tracking-tighter text-white">{title}</h2>
          <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
        </div>
        {/* "Back to Marketplace" pointed at a surface removed on 2026-11-05,
            and promised a stranger a store of other people that never
            existed for them. There is nowhere for a guest to go — the link
            was their whole entry — so this closes the screen instead of
            pretending otherwise. */}
        {/* The terms-changed screen tells the reader to look at the current
            terms, so it offers that rather than making them find the link
            again. Everywhere else there is genuinely nowhere for a guest to
            go — the link was their whole entry — and a button that pretends
            otherwise is worse than none. */}
        <div className="flex flex-col items-center gap-3">
          {termsChanged && (
            <button
              onClick={() => window.location.reload()}
              className="px-8 py-3 rounded-2xl bg-white text-[#020617] font-black text-sm hover:bg-indigo-400 hover:text-white transition-all"
            >
              Show me the current terms
            </button>
          )}
          <button
            onClick={onDecline}
            className="px-8 py-3 border border-white/10 rounded-2xl font-bold text-slate-300 hover:text-white hover:border-white/20 transition-all text-sm"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Field names are the contract row's own — these values came from the
  // database through the validated invite path, not from the URL.
  const {
    project_name: project,
    amount_jpy: amount,
    currency,
    deadline,
    earner_display_name: inviter,
    invited_hirer_email: invitedEmail,
    performed_by: performedBy,
    dod,
  } = inviteData;
  // Which side does the work. It is bound into the agreement snapshot the
  // moment this invitation is accepted, so it has to be on screen first —
  // attesting consent to a term nobody was shown would be dishonest. Older
  // invites predate the column; 'creator' is what those agreements meant.
  const guestPerforms = (performedBy ?? 'creator') === 'counterparty';
  // The address this acceptance will be recorded under.
  //
  // The email field is prefilled with the address the invite was sent to, and
  // a guest may accept at that address without editing it. Everything that
  // acts on the email therefore reads the edited value when there is one and
  // the prefilled one otherwise. Previously the field rendered the prefilled
  // address while the submit button and onAccept read only `guestEmail`, so
  // anyone who simply accepted what was shown faced a permanently disabled
  // button with nothing explaining why.
  //
  // This does not merge the two concepts. invited_hirer_email stays the
  // address the Earner addressed the invite to and is never written here;
  // hirer_email is whoever actually accepted, which the server records from
  // this value. The two coincide when the guest accepts as invited, and differ
  // when they type a different address — both remain separately recorded.
  const acceptingEmail = (guestEmail || invitedEmail || '').trim();

  const amountLabel = amount > 0
    ? new Intl.NumberFormat(undefined, {
        style: 'currency', currency: currency ?? 'JPY', maximumFractionDigits: 0,
      }).format(amount)
    : "TBD";
  const deadlineLabel = deadline
    ? new Date(`${deadline}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Not set';

  if (stage === 'identify') {
    return (
      <div className="space-y-8 animate-fade-in-up max-w-md mx-auto">
        <div className="text-center space-y-3">
          <div className="w-14 h-14 bg-indigo-500/10 border border-indigo-500/20 rounded-[20px] flex items-center justify-center mx-auto">
            <User className="w-7 h-7 text-indigo-400" />
          </div>
          <h2 className="text-3xl font-black tracking-tighter text-white">How should we address you?</h2>
          <p className="text-slate-400 text-sm leading-relaxed max-w-xs mx-auto">
            Your replies and actions on this contract will be recorded under this name.
            No account required yet.
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Your name or handle"
            autoFocus
            className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-5 text-white text-lg font-bold outline-none transition-all placeholder:text-slate-400"
          />
          <div className="space-y-1">
            <input
              type="email"
              value={guestEmail || invitedEmail || ''}
              onChange={e => setGuestEmail(e.target.value)}
              placeholder="Email address (required for contract record)"
              className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-4 text-white font-medium outline-none transition-all placeholder:text-slate-400"
            />
            {/* "A copy will be sent to you" promised an email nothing sends:
                send-acceptance-email was deleted on 2026-09-26 and is not to
                be redeployed. The record is downloadable instead, which is
                true, and the link is what gets them back to it. */}
            {/* A blind counterparty read the prefilled value as an address of
                someone else's about to be recorded as them: "私のメールでは
                ない偽のものが私の識別子として記録される" (2026-11-06). The
                field was always editable and the box always said what it was
                for — but it never said whose address was already in it, or
                that replacing it is normal. Saying so costs one line. */}
            <p className="text-xs text-slate-400 px-2">
              {invitedEmail && (guestEmail || invitedEmail) === invitedEmail
                ? <>This is the address the invitation was sent to. <span className="text-slate-300">Change it if it is not yours</span> — whatever is here is recorded as who accepted.</>
                : <>Recorded with this agreement as who accepted.</>}
              {' '}No acceptance email is sent — your copy is downloadable from the record, and this link is how you reach it again.
            </p>
          </div>
          {/* The terms again, at the moment of commitment.
              Rendered from the same `inviteData` the previous screen used and
              that acceptance sends back, never from separate state: a second
              source could show one thing and record another, and the row is
              re-checked server-side at acceptance anyway (row_version,
              20260928000000_atomic_acceptance.sql). The checkbox used to
              reference "the terms on the previous screen" with the previous
              screen gone — a blind reviewer said so, and Codex's design review
              set the condition that this recap share one source. */}
          <div className="p-4 bg-white/[0.03] border border-white/5 rounded-2xl space-y-2">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">What you are agreeing to</p>
            <dl className="text-xs text-slate-300 space-y-1">
              <div className="flex gap-2"><dt className="text-slate-400 w-20 shrink-0">Work</dt><dd>{project}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-400 w-20 shrink-0">Done when</dt><dd>{(dod ?? []).join(' · ') || 'Not set'}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-400 w-20 shrink-0">Amount</dt><dd>{amountLabel}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-400 w-20 shrink-0">By</dt><dd>{deadlineLabel}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-400 w-20 shrink-0">Who works</dt><dd>{guestPerforms ? 'You' : inviter}</dd></div>
            </dl>
            <p className="text-[11px] text-slate-400">A summary of the previous screen, not a replacement for it.</p>
          </div>

          {/* Deliberately NOT inside the box above, and not inside the consent
              label: this is what the agreement does not cover, and listing it
              among the terms would invite reading it as one of them (Codex
              design review, 2026-11-05). */}
          <div className="p-4 border border-amber-500/20 bg-amber-500/[0.04] rounded-2xl space-y-1">
            <p className="text-[10px] font-black text-amber-400/80 uppercase tracking-widest">Not settled by this agreement</p>
            <p className="text-xs text-slate-300 leading-relaxed">
              When and how the {amountLabel} is paid is not part of what you are
              accepting here, and TrustFlow does not process the payment. Arrange it
              with {inviter} directly. Afterwards either of you can record that a
              payment was sent or received — TrustFlow stores that statement, it does
              not check it.
            </p>
          </div>

          <label className="flex items-start gap-3 p-4 bg-white/[0.03] border border-white/5 rounded-2xl cursor-pointer select-none">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={e => setConsentChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded accent-indigo-500 shrink-0"
            />
            <span className="text-xs text-slate-400 leading-relaxed">
              I have reviewed the terms above — the work, what counts as done, the amount and the deadline — and I agree to them. I understand that my acceptance will be timestamped and recorded as a binding agreement.
            </span>
          </label>
          <button
            onClick={() => onAccept(displayName.trim() || 'Guest', acceptingEmail)}
            disabled={!displayName.trim() || !acceptingEmail || !consentChecked}
            className="w-full py-5 bg-white text-[#020617] rounded-[24px] font-black text-lg flex items-center justify-center gap-3 hover:bg-indigo-400 hover:text-white transition-all shadow-2xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-[#020617]"
          >
            I Agree — Join This Contract
            <ArrowRight className="w-5 h-5" />
          </button>
          <button
            onClick={() => setStage('review')}
            className="w-full py-3 text-slate-400 hover:text-slate-400 transition-colors font-bold text-sm"
          >
            ← Back
          </button>
        </div>

        {/* No account is created for a counterparty, and none is offered: the
            link is the credential. Saying otherwise promised a sign-up that
            does not exist. */}
        <p className="text-center text-xs text-slate-400 pb-4">
          No account needed. This link is your access — keep it, and ask the
          other party for a new one if you lose it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-fade-in-up max-w-2xl mx-auto">

      {/* Header */}
      <div className="text-center space-y-3">
        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.3em]">You've been invited</p>
        {/* The direction belongs in the headline, not in a label further down
            the card. A reviewer shown these screens with no context read
            "{inviter} wants to work with you" plus an unsigned ¥20,000 as an
            offer of work TO them, and only found "you pay" in small text
            lower down (blind review, 2026-11-05). Which side pays is the
            first thing a stranger needs and the last thing they should have
            to infer. */}
        <h1 className="text-4xl sm:text-5xl font-black tracking-tighter text-white leading-none">
          {guestPerforms
            ? <>{inviter} is asking you to do this work.</>
            : <>{inviter} is offering to do this work for you.</>}
        </h1>
        <p className="text-slate-400 text-base leading-relaxed max-w-md mx-auto">
          {guestPerforms
            ? <>You do the work · {inviter} pays you. The terms below are recorded exactly as they stand when you accept.</>
            : <>{inviter} does the work · you pay. The terms below are recorded exactly as they stand when you accept.</>}
        </p>
        <p className="text-xs font-bold text-slate-400">No account required to review.</p>
      </div>

      {/* Project card */}
      <div className="bg-[#0f172a]/80 border border-white/10 rounded-[40px] p-8 space-y-5 shadow-2xl backdrop-blur-xl">
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Project</p>
          <h2 className="text-2xl font-black text-white tracking-tight">{project}</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Contract Value</p>
            <p className="text-3xl font-black italic text-white">{amountLabel}</p>
            {/* Scoped to this agreement on purpose. "TrustFlow never holds
                money" would be a product claim the screen cannot make: the
                Stripe functions exist in the repository and their deployment
                is not knowable from here (Codex design review, 2026-11-05).
                What is true and checkable is what happens to THIS one. */}
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Not paid through TrustFlow. {guestPerforms ? <>{inviter} pays you</> : <>You pay {inviter}</>} directly,
              by whatever means you two arrange.
            </p>
          </div>
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Deadline</p>
            <p className="text-lg font-black text-white pt-2">{deadlineLabel}</p>
          </div>
        </div>
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Who does the work</p>
          <p className="text-sm font-bold text-white">
            {guestPerforms
              ? <>You do the work · {inviter} pays</>
              : <>{inviter} does the work · you pay</>}
          </p>
        </div>
        {dod.length > 0 && (
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">What counts as complete</p>
            <div className="space-y-2">
              {dod.map((item, i) => (
                <div key={i} className="flex items-start gap-3 text-sm text-slate-300">
                  <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                  <span className="font-medium">{item}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* What you gain */}
      <div className="space-y-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">What you get by joining</p>
        {GAINS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-4 p-5 bg-white/[0.03] border border-white/5 rounded-[24px]">
            <div className="shrink-0 w-10 h-10 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center">
              <Icon className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <p className="font-black text-white text-sm mb-1">{title}</p>
              <p className="text-xs text-slate-400 leading-relaxed">{body}</p>
            </div>
          </div>
        ))}
      </div>

      {/* CTAs */}
      <div className="flex flex-col gap-3 max-w-md mx-auto w-full pb-8">
        <button
          onClick={() => setStage('identify')}
          className="w-full py-5 bg-white text-[#020617] rounded-[24px] font-black text-lg flex items-center justify-center gap-3 hover:bg-indigo-400 hover:text-white transition-all shadow-2xl"
        >
          Review Agreement
          <ArrowRight className="w-5 h-5" />
        </button>
        <button
          onClick={onDecline}
          className="w-full py-4 border border-white/10 rounded-[24px] font-bold text-slate-400 hover:text-white hover:border-white/20 transition-all flex items-center justify-center gap-2 text-sm"
        >
          <X className="w-4 h-4" />
          Not interested
        </button>
        <p className="text-center text-xs text-slate-400">
          No payment or commitment at this stage — you review the full terms before anything is locked.
        </p>
      </div>
    </div>
  );
};

export default InviteView;
