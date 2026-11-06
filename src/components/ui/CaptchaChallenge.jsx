// src/components/ui/CaptchaChallenge.jsx
//
// The Turnstile widget, rendered where a person is already filling in a form.
//
// It appears in exactly two places — claiming an email to create the first
// contract, and signing back in — because those are the two Supabase endpoints
// CAPTCHA protection covers (see lib/captcha.js). It deliberately does NOT
// appear on load: a challenge shown to someone who has only opened the page is
// a toll on reading, and the anonymous session that used to be minted there is
// no longer created at all.
//
// Renders nothing when Turnstile cannot be reached. A challenge that failed to
// load must not look like a challenge that was failed, and the auth call it
// guards degrades on its own terms: with no token the server either does not
// require one, or answers captcha_failed, which the caller reports as what it
// is.

import { useEffect, useRef, useState } from 'react';
import { renderCaptcha, captchaConfigured, captchaIsTestKey } from '../../lib/captcha.js';

export default function CaptchaChallenge({ onToken, className = '' }) {
  const host = useRef(null);
  const [available, setAvailable] = useState(true);

  // onToken is held in a ref so that a parent re-render does not tear down and
  // rebuild the widget: Turnstile issues one token per render, and remounting
  // discards a solved challenge the person has already sat through.
  const latest = useRef(onToken);
  useEffect(() => { latest.current = onToken; }, [onToken]);

  useEffect(() => {
    let dispose = null;
    let alive = true;

    renderCaptcha(host.current, (token) => latest.current?.(token)).then((d) => {
      if (!alive) { d?.(); return; }
      dispose = d;
      if (!d) setAvailable(false);
    });

    return () => { alive = false; dispose?.(); };
  }, []);

  // Unconfigured is not a failure and must leave no trace on the page: a
  // deployment without a site key has no CAPTCHA, and saying so to a visitor
  // would be noise about someone else's settings.
  if (!captchaConfigured() || !available) return null;

  return (
    <div className={className}>
      <div ref={host} />
      {captchaIsTestKey() && (
        // Visible on purpose. A build carrying Cloudflare's always-passes test
        // key looks identical to a protected one until an auth call fails, and
        // that ambiguity is what made the 2026-11-06 outage hard to read.
        <p className="mt-2 text-[10px] font-bold tracking-wider text-amber-400/80 uppercase">
          Test challenge key — not configured for this deployment
        </p>
      )}
    </div>
  );
}
