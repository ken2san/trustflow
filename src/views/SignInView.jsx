// src/views/SignInView.jsx
//
// Sign-in for an Earner returning on a browser that has never held their
// session — a new device, cleared storage, a different profile.
//
// There is no password because there never was one: the account began as an
// anonymous session that later claimed an email address. A code sent to that
// address is the only credential that exists, and it returns a session on the
// same auth.users.id, which is what makes the contracts reappear.
//
// This screen only signs people in. It cannot create an account (the request
// is sent with shouldCreateUser: false), so a mistyped address fails rather
// than quietly producing a second, empty account.

import React from 'react';
import { Mail, ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import { RATE_LIMIT_MESSAGE } from '../lib/earnerAuth.js';

const REQUEST_ERRORS = {
  unknown_email:
    'No account was found for that address, or a code could not be sent to it. '
    + 'Check the spelling and try again.',
  rate_limited: RATE_LIMIT_MESSAGE,
  invalid_email: 'That does not look like an email address.',
  not_configured: 'Sign-in is unavailable — this build has no Supabase connection.',
  error: 'The code could not be sent. Try again in a moment.',
};

const VERIFY_ERRORS = {
  invalid_code: 'That code was not correct. Check the most recent email and try again.',
  expired_code: 'That code has expired. Request a new one.',
  not_configured: 'Sign-in is unavailable — this build has no Supabase connection.',
  error: 'The code could not be checked. Try again in a moment.',
};

export default function SignInView({
  initialEmail = '', expired = false, onRequestCode, onVerifyCode, onBack,
}) {
  const [email, setEmail] = React.useState(initialEmail ?? '');
  const [code, setCode] = React.useState('');
  const [stage, setStage] = React.useState('email'); // 'email' | 'busy' | 'code' | 'verifying'
  const [error, setError] = React.useState(null);

  const busy = stage === 'busy' || stage === 'verifying';

  const sendCode = async () => {
    setError(null);
    setStage('busy');
    const { ok, reason } = await onRequestCode(email.trim());
    if (!ok) {
      setError(REQUEST_ERRORS[reason] ?? REQUEST_ERRORS.error);
      setStage('email');
      return;
    }
    setStage('code');
  };

  const submitCode = async () => {
    setError(null);
    setStage('verifying');
    const { user, reason } = await onVerifyCode(email.trim(), code.trim());
    if (!user) {
      setError(VERIFY_ERRORS[reason] ?? VERIFY_ERRORS.error);
      setStage('code');
      return;
    }
    // On success the parent swaps the view; nothing to do here.
  };

  return (
    <div className="max-w-md mx-auto py-16 space-y-8 animate-fade-in-up">
      <header className="space-y-3">
        <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
          <Mail className="w-5 h-5 text-indigo-400" />
        </div>
        <h1 className="text-3xl font-black tracking-tighter text-white">
          {expired ? 'Sign in again' : 'Sign in'}
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          {expired
            ? 'Your session has ended. Sign in with the same email to get your contracts back — nothing has been lost.'
            : 'Enter the email address your contracts were created under. We will send you a code.'}
        </p>
      </header>

      {stage === 'email' || stage === 'busy' ? (
        <div className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && email.trim() && !busy) sendCode(); }}
            placeholder="you@example.com"
            autoFocus
            aria-label="Email address"
            className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-4 text-white font-medium outline-none transition-all placeholder:text-slate-600"
          />
          <button
            onClick={sendCode}
            disabled={!email.trim() || busy}
            className="w-full py-4 rounded-2xl bg-white text-[#020617] font-black hover:bg-indigo-400 hover:text-white transition-all disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-[#020617] flex items-center justify-center gap-2"
          >
            {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : 'Send me a code'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            A code was sent to <span className="text-slate-300">{email}</span>.
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            // This project's OTP length is 8 (a project setting, kept as-is
            // rather than changed back to Supabase's 6-digit default).
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={e => { if (e.key === 'Enter' && code.trim() && !busy) submitCode(); }}
            placeholder="12345678"
            autoFocus
            aria-label="Sign-in code"
            className="w-full bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-2xl px-6 py-4 text-white text-2xl font-mono tracking-[0.4em] text-center outline-none transition-all placeholder:text-slate-700"
          />
          <button
            onClick={submitCode}
            disabled={!code.trim() || busy}
            className="w-full py-4 rounded-2xl bg-white text-[#020617] font-black hover:bg-indigo-400 hover:text-white transition-all disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-[#020617] flex items-center justify-center gap-2"
          >
            {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking…</> : 'Sign in'}
          </button>
          <button
            onClick={() => { setStage('email'); setCode(''); setError(null); }}
            className="w-full py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Use a different address
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-xs text-amber-400 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </p>
      )}

      <p className="text-[11px] text-slate-600 leading-relaxed border-t border-white/5 pt-4">
        This signs you back into an existing account. It does not create one — if you have never
        set up a contract here, start one instead and you will be asked to confirm your email then.
      </p>

      {onBack && (
        <button onClick={onBack} className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
      )}
    </div>
  );
}
