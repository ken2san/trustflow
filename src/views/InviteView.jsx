import { useState } from "react";
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
    title: "What you accept is recorded, not remembered.",
    body: "Accepting writes a timestamped record of these exact terms — the amount, the deadline and what counts as done. Each later step is hash-linked to the one before it, so an edit afterwards cannot pass as the original.",
  },
  {
    icon: Download,
    title: "You get your own copy of the record.",
    body: "Everything recorded against this agreement, downloadable as a file that is yours to keep. No account needed, and it does not depend on TrustFlow still being here to read it.",
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

  // Token error states (expired, tampered, malformed)
  if (tokenError || !inviteData) {
    const isExpired = tokenError === 'expired';
    const Icon = isExpired ? Clock : AlertTriangle;
    const title = isExpired ? 'This invite has expired.' : 'Invalid invite link.';
    const body = isExpired
      ? 'Invite links are valid for 72 hours. Ask the sender to generate a new one.'
      : 'This link may have been modified or is malformed. Please request a fresh invite link.';
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 max-w-md mx-auto text-center animate-fade-in-up">
        <div className="w-16 h-16 bg-amber-500/10 border border-amber-500/20 rounded-[20px] flex items-center justify-center">
          <Icon className="w-8 h-8 text-amber-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-black tracking-tighter text-white">{title}</h2>
          <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
        </div>
        <button
          onClick={onDecline}
          className="px-8 py-3 border border-white/10 rounded-2xl font-bold text-slate-400 hover:text-white hover:border-white/20 transition-all text-sm"
        >
          Back to Marketplace
        </button>
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
            className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-5 text-white text-lg font-bold outline-none transition-all placeholder:text-slate-600"
          />
          <div className="space-y-1">
            <input
              type="email"
              value={guestEmail || invitedEmail || ''}
              onChange={e => setGuestEmail(e.target.value)}
              placeholder="Email address (required for contract record)"
              className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-4 text-white font-medium outline-none transition-all placeholder:text-slate-600"
            />
            <p className="text-xs text-slate-600 px-2">Your email is attached to this agreement as your identifier. A copy will be sent to you.</p>
          </div>
          <label className="flex items-start gap-3 p-4 bg-white/[0.03] border border-white/5 rounded-2xl cursor-pointer select-none">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={e => setConsentChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded accent-indigo-500 shrink-0"
            />
            <span className="text-xs text-slate-400 leading-relaxed">
              I have reviewed the Definition of Done above and agree to these terms. I understand that my acceptance will be timestamped and recorded as a binding agreement.
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
            className="w-full py-3 text-slate-600 hover:text-slate-400 transition-colors font-bold text-sm"
          >
            ← Back
          </button>
        </div>

        {/* No account is created for a counterparty, and none is offered: the
            link is the credential. Saying otherwise promised a sign-up that
            does not exist. */}
        <p className="text-center text-xs text-slate-600 pb-4">
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
        <h1 className="text-4xl sm:text-5xl font-black tracking-tighter text-white leading-none">
          {inviter} wants to work with you.
        </h1>
        <p className="text-slate-400 text-base leading-relaxed max-w-md mx-auto">
          They set up a TrustFlow contract — so both sides are protected, not just them.
        </p>
        <p className="text-xs font-bold text-slate-500">No account required to review.</p>
      </div>

      {/* Project card */}
      <div className="bg-[#0f172a]/80 border border-white/10 rounded-[40px] p-8 space-y-5 shadow-2xl backdrop-blur-xl">
        <div>
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Project</p>
          <h2 className="text-2xl font-black text-white tracking-tight">{project}</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Contract Value</p>
            <p className="text-3xl font-black italic text-white">{amountLabel}</p>
          </div>
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Deadline</p>
            <p className="text-lg font-black text-white pt-2">{deadlineLabel}</p>
          </div>
        </div>
        <div>
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Who does the work</p>
          <p className="text-sm font-bold text-white">
            {guestPerforms
              ? <>You do the work · {inviter} pays</>
              : <>{inviter} does the work · you pay</>}
          </p>
        </div>
        {dod.length > 0 && (
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">What counts as complete</p>
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
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest text-center">What you get by joining</p>
        {GAINS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-4 p-5 bg-white/[0.03] border border-white/5 rounded-[24px]">
            <div className="shrink-0 w-10 h-10 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center">
              <Icon className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <p className="font-black text-white text-sm mb-1">{title}</p>
              <p className="text-xs text-slate-500 leading-relaxed">{body}</p>
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
          className="w-full py-4 border border-white/10 rounded-[24px] font-bold text-slate-500 hover:text-white hover:border-white/20 transition-all flex items-center justify-center gap-2 text-sm"
        >
          <X className="w-4 h-4" />
          Not interested
        </button>
        <p className="text-center text-xs text-slate-600">
          No payment or commitment at this stage — you review the full terms before anything is locked.
        </p>
      </div>
    </div>
  );
};

export default InviteView;
