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

const REQUEST_ERRORS = {
  unknown_email:
    'No account was found for that address, or a code could not be sent to it. '
    + 'Check the spelling and try again.',
  rate_limited:
    'Too many codes have been requested recently. Wait a few minutes and try again.',
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

/** Google's four-color "G" mark, inline — a login button, not literally the browser. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="w-4 h-4" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.97v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.97A9 9 0 0 0 0 9c0 1.45.35 2.83.97 4.04l2.98-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .97 4.97l2.98 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}

export default function SignInView({
  initialEmail = '', expired = false, onRequestCode, onVerifyCode, onGoogleSignIn, onBack,
}) {
  const [email, setEmail] = React.useState(initialEmail ?? '');
  const [code, setCode] = React.useState('');
  const [stage, setStage] = React.useState('email'); // 'email' | 'busy' | 'code' | 'verifying'
  const [error, setError] = React.useState(null);
  const [googleBusy, setGoogleBusy] = React.useState(false);

  const busy = stage === 'busy' || stage === 'verifying';

  const startGoogle = async () => {
    setError(null);
    setGoogleBusy(true);
    const { error: err } = await onGoogleSignIn();
    // On success the browser navigates away to Google before this returns.
    // It only comes back here if the redirect itself could not start.
    if (err) {
      setError('Could not start Google sign-in. Try again in a moment.');
      setGoogleBusy(false);
    }
  };

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

      {(stage === 'email' || stage === 'busy') && onGoogleSignIn && (
        <div className="space-y-4">
          <button
            onClick={startGoogle}
            disabled={busy || googleBusy}
            className="w-full py-4 rounded-2xl border border-white/10 text-white font-bold hover:bg-white/5 transition-all disabled:opacity-40 flex items-center justify-center gap-2.5"
          >
            {googleBusy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</>
              : <><GoogleMark /> Continue with Google</>}
          </button>
          <div className="flex items-center gap-3 text-[11px] text-slate-600">
            <span className="flex-1 h-px bg-white/10" /> or <span className="flex-1 h-px bg-white/10" />
          </div>
        </div>
      )}

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
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => { if (e.key === 'Enter' && code.trim() && !busy) submitCode(); }}
            placeholder="123456"
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
