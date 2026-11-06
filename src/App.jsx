
/**
 * @typedef {Object} UIProfileStats
 * @property {number} trustScore
 * @property {number} level
 * @property {number} exp
 * @property {number} completedContracts
 * @property {number} avgRating
 * @property {Array<string>} badges
 * @property {Object.<string, number>} skillEndorsements
 * @property {number} repeatClients
 * @property {number} totalEarned
 * @property {number} totalSpent
 * @property {number} points
 * @property {string} responseSpeed
 * @property {boolean} verified
 * @property {string} location
 * @property {string} joinDate
 */

/**
 * @typedef {Object} InternalProfileStats
 * @property {Array<{
 *   type: string,
 *   value: number,
 *   rating: number,
 *   date: string,
 *   partnerId: string,
 *   feedback: string,
 *   contractId: string
 * }>} recentHistory
 * @property {Array<{
 *   comment: string,
 *   rating: number,
 *   date: string,
 *   partnerId: string
 * }>} feedbackComments
 * @property {Array<{
 *   field: string,
 *   oldValue: any,
 *   newValue: any,
 *   date: string
 * }>} profileChangeLog
 * @property {string} joinDate
 * @property {string} lastActive
 * @property {Array<{
 *   id: string,
 *   type: string,
 *   connectedAt: string
 * }>} networkGraph
 */


import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  ShieldCheck, CheckCircle2, Search, Activity, X, LayoutGrid, Loader2, RefreshCw, Briefcase, UserPlus, LogIn, LogOut, XCircle,
} from 'lucide-react';
// Returns a unified profile object merging static and dynamic user data
// (moved below imports)

// Centralized constants and mock data
import { sha256, buildDodCanonical } from './lib/crypto.js';
import { logEvent, EVENT_TYPES, fetchContractEvents } from './lib/eventLog.js';
import { downloadAuditTrail } from './lib/auditExport.js';
import { downloadGuestRecord } from './lib/guestRecordExport.js';
import { loadRuntimeSnapshot, restorableView, saveRuntimeSnapshot } from './lib/runtimeState.js';
import { currentActorIdentity, ensureActorIdentity } from './lib/identity.js';
import { createContract, listContracts, inviteUrlFor, fetchInvite, acceptInvite, fetchGuestEvidence, deleteDraftContract, reissueGuestAccess, guestAccessUrlFor, shownTermsDigest } from './lib/contracts.js';
import { storeGuestAccessToken, listGuestAgreementIds, getGuestAgreementLabel } from './lib/guestSession.js';
import {
  requestEarnerVerification, verifyEarnerOtp, isEarnerVerified,
  requestSignInCode, verifySignInCode, getAuthState, signOutEarner,
  describeAuthError,
} from './lib/earnerAuth.js';


// ...existing code...


/* ========================================================================
   2. CUSTOM HOOKS
   ======================================================================== */



/* ========================================================================
   3. UI COMPONENTS (ATOMS & MOLECULES)
   ======================================================================== */

// NeuralBackground moved to components/ui/NeuralBackground.jsx
import NeuralBackground from './components/ui/NeuralBackground';






// ToastContainer moved to components/ui/ToastContainer.jsx
import ToastContainer from './components/ui/ToastContainer';


/* ========================================================================
   4. FEATURE MODALS
   ======================================================================== */


// ProfileModal moved to components/modals/ProfileModal.jsx

// CommandPalette component for command modal
import CommandPalette from './components/ui/CommandPalette.jsx';
import CaptchaChallenge from './components/ui/CaptchaChallenge.jsx';
import { captchaConfigured } from './lib/captcha.js';




// DisputeModal moved to components/modals/DisputeModal.jsx


// PaymentModal moved to components/modals/PaymentModal.jsx



// --- Page Views ---

// OnboardingView moved to views/OnboardingView.jsx
import OnboardingView from './views/OnboardingView';

// MarketplaceView moved to views/MarketplaceView.jsx

// ScopingView moved to views/ScopingView.jsx

// ContractView moved to views/ContractView.jsx

// WalletView moved to views/WalletView.jsx
import GuestEvidenceView from './views/GuestEvidenceView';
import ContractsHomeView from './views/ContractsHomeView';
import SignInView from './views/SignInView';
import AgreementView from './views/AgreementView';
import { performsHere } from './lib/contractStatus.js';

// CommandCenterView moved to views/CommandCenterView.jsx

// ProjectDetailView moved to views/ProjectDetailView.jsx

// InviteView for counterparty invite link flow
import InviteView from './views/InviteView';

// Today as an <input type="date"> writes it: a calendar date in the viewer's
// own timezone. toISOString() would be a day early for anyone ahead of UTC —
// including Tokyo, where this is being used — and would let "today" be
// rejected as past.
const todayLocalISO = () => new Date().toLocaleDateString('en-CA');

// --- Main App Component ---

/** @see onGuestSurface, below. */
const GUEST_SURFACE_VIEWS = new Set(['invite', 'invite-accepted', 'invite-declined', 'guest-evidence']);

const App = () => {
  // The query string as the page was opened with, captured during the first
  // render so that nothing below has to read it live.
  //
  // It is mutable global state and one of the effects rewrites it: the guest
  // recovery link strips its own token from the address bar as soon as it has
  // it. Readers that run after an await therefore saw a DIFFERENT URL from
  // readers that ran synchronously, and the hydrate effect — which awaits
  // identity and the runtime snapshot first — concluded there was no guest
  // parameter and restored the saved view straight over the agreement the
  // guest had just been sent to. The agreement loaded; the screen showed "No
  // contracts yet". Reproduced on 2026-10-11.
  //
  // dataBackedViews below stops a saved view being restored TO 'agreement'.
  // It could not stop one being restored OVER it, which is why capturing the
  // URL once is the fix rather than another exclusion.
  const [initialParams] = useState(() => new URLSearchParams(window.location.search));
  const [mode, setMode] = useState('earner');
  // Detect invite link params on mount; set initial view accordingly.
  // Supports two URL formats:
  //   ?token=<signed>   — new format (HMAC-signed, 72h expiry)
  //   ?invite=1&...     — legacy format (backward compat)
  // The invite URL carries an opaque server-issued token and nothing else.
  // Every contractual value shown to the Hirer is fetched from the contract
  // row (see the invite fetch effect below). Two older formats are gone on
  // purpose: an HMAC token whose payload *contained* the terms, and a legacy
  // ?invite=1 that read project/amount/dod straight from query params. A URL
  // may identify a contract; it must not carry what the contract says.
  const [inviteData, setInviteData] = useState(null);
  const [inviteLoading, setInviteLoading] = useState(() => initialParams.has('token'));
  const [inviteTokenError, setInviteTokenError] = useState(null);
  // The guest Hirer's evidence trail, fetched on demand from the contract's
  // guest credential. Null until they ask to see it.
  const [guestEvidence, setGuestEvidence] = useState(null);
  const [guestEvidenceReason, setGuestEvidenceReason] = useState(null);
  // The one agreement currently open, from whichever side. `role` is
  // 'performer' or 'receiver'; the server decides which, and the screen only
  // offers the action that belongs to it.
  const [agreement, setAgreement] = useState(null);
  const [agreementBusy, setAgreementBusy] = useState(false);
  const [agreementError, setAgreementError] = useState(null);
  // 'home' is the Contracts list. Marketplace and Command Center still exist
  // and still render, but nothing in the primary navigation points at them —
  // see the command palette for the remaining way in.
  const [view, setView] = useState(() => (initialParams.has('token') ? 'invite' : 'home'));
  // Who this browser is acting as: 'signed_in', 'anonymous' or 'expired'.
  // Resolved on load from the persisted session — supabase-js restores and
  // refreshes it itself, so this only has to report what it found.
  const [auth, setAuth] = useState({ status: 'anonymous', email: null, userId: null });
  // The signed-in Earner's own contracts, read straight from the database.
  const [myContracts, setMyContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(true);
  const [contractsError, setContractsError] = useState(null);

  const [selectedItem, setSelectedItem] = useState(null);
  const [status, setStatus] = useState('idle');

  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasOnboarded, setHasOnboarded] = useState(() => {
    if (initialParams.has('reset')) {
      localStorage.removeItem('tf_onboarded');
      return false;
    }
    return !!localStorage.getItem('tf_onboarded');
  });
  const [showBYOCForm, setShowBYOCForm] = useState(false);
  const [byocForm, setByocForm] = useState({ name: '', description: '', amount: '', dod: '' });
  const [inviteLink, setInviteLink] = useState(null);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  // Earner verification (A-1): the contract is only persisted once the Earner
  // has proved an email, so a cleared browser cannot orphan a real agreement.
  const [otpStage, setOtpStage] = useState('idle'); // 'idle' | 'busy' | 'code'
  // The Turnstile token, when the deployment is protected. Null is the normal
  // resting state: the widget sets it on solve and clears it on expiry, and
  // the auth calls omit the field entirely rather than sending an empty one.
  const [captchaToken, setCaptchaToken] = useState(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState(null);
  const [isRuntimeHydrated, setIsRuntimeHydrated] = useState(false);
  const [actorId, setActorId] = useState('user');
  // Mirrors actorId for the contract-events subscription below, whose effect
  // deps are [selectedItem?.id] only (re-subscribing on every actorId change
  // would be wasteful). Without this, the subscription callback's closure
  // could capture the default 'user' actorId if a contract gets selected
  // before ensureActorIdentity() resolves — every self-emitted event would
  // then fail the `ev.actor_id === actorId` self-check and get misread as a
  // counterparty event (bogus "counterparty advanced" toast + step re-sync).
  const actorIdRef = useRef(actorId);
  useEffect(() => { actorIdRef.current = actorId; }, [actorId]);



  useEffect(() => { const handleKeyDown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setIsCommandOpen(prev => !prev); } }; window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown); }, []);

  // Load the invite from the contract row. Read-only: this does not consume
  // the one-time token — that happens when the Hirer actually accepts.
  // Load the signed-in user's contracts. RLS decides which rows come back, so
  // an anonymous or signed-out session simply sees none — which is the correct
  // empty state, not an error.
  const refreshContracts = useCallback(async () => {
    setContractsLoading(true);
    const { contracts, error } = await listContracts();
    setMyContracts(contracts);
    setContractsError(error ? (error.message ?? String(error)) : null);
    setContractsLoading(false);
  }, []);

  // Session restoration. supabase-js reads the stored session and refreshes it
  // before this resolves, so by the time getAuthState answers, an expired
  // refresh token has already failed and reports as 'expired' rather than
  // looking like a brand-new visitor.
  useEffect(() => {
    let alive = true;
    (async () => {
      const state = await getAuthState();
      if (!alive) return;
      setAuth(state);

      const { contracts, error } = await listContracts();
      if (!alive) return;
      setMyContracts(contracts);
      setContractsError(error ? (error.message ?? String(error)) : null);
      setContractsLoading(false);
    })();
    return () => { alive = false; };
  }, []);


  useEffect(() => {
    const raw = initialParams.get('token');
    if (!raw) return;
    let alive = true;
    fetchInvite(raw).then(({ invite, reason }) => {
      if (!alive) return;
      if (invite) setInviteData(invite);
      else setInviteTokenError(reason);
      setInviteLoading(false);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;

    const hydrate = async () => {
      // Reads an existing session; deliberately does NOT create one. See
      // identity.js — an anonymous user per page view was both junk and an
      // unauthenticated write surface, and nothing on this path needs a
      // server identity.
      const identity = await currentActorIdentity();
      if (alive && identity?.actorId) setActorId(identity.actorId);

      const snapshot = await loadRuntimeSnapshot(identity?.actorId);
      if (!alive) return;

      if (snapshot) {
        if (typeof snapshot.hasOnboarded === 'boolean') setHasOnboarded(snapshot.hasOnboarded);
        if (typeof snapshot.mode === 'string') setMode(snapshot.mode);
        // Don't restore view when an invite token is present in the URL
        // Read from the captured query, not the live one: by the time this
        // runs the guest effect has already stripped its token out of the URL.
        const hasInviteParams = initialParams.has('token')
          || initialParams.has('invite')
          // A re-issued guest link opens the agreement itself; a restored
          // view would race it for the same screen.
          || initialParams.has('guest');
        // Which views a restore may land on is RESTORABLE_VIEWS' decision, not
        // this effect's: the reason is about what the snapshot carries, and the
        // snapshot's shape is defined in that module. It used to be an
        // exclusion list of two names here, which covered the one case already
        // hit ('agreement', a spinner that never resolved) and left every other
        // view restorable by default.
        if (!hasInviteParams) setView(restorableView(snapshot.view));
        if (snapshot.selectedItem) setSelectedItem(snapshot.selectedItem);
        if (snapshot.byocForm) setByocForm(snapshot.byocForm);
        // step, uiProfile, internalProfile, acceptanceProtocol, badActorFlags
        // and contractHistory were restored here until 2026-11-05. Each had no
        // writer left once the reputation layer and the five-step flow went
        // (Decisions.md), so restoring them only re-seeded a constant. A row
        // written before today still carries them; nothing reads them now.
        if (Array.isArray(snapshot.activityLog)) setActivityLog(snapshot.activityLog.map(e => ({ ...e, timestamp: new Date(e.timestamp) })));
      }

      setIsRuntimeHydrated(true);
    };

    hydrate();

    return () => {
      alive = false;
    };
  }, []);

  // A realtime subscription on the selected contract's events used to live
  // here. It is gone (2026-11-05) with the five-step flow it served.
  //
  // It kept a `contractEvents` array nothing read any more, advanced the
  // legacy `step`, and toasted when the counterparty acted. The evidence path
  // never used it: openContractFromHome fetches the owner's events itself,
  // recordAgreementEvent re-reads them after a write, and the guest screen is
  // built from fetchGuestEvidence. What reach it still had was accidental —
  // it keyed off `selectedItem`, which after the removal is set only by the
  // guest acceptance path, so a "your counterparty advanced the contract"
  // toast could fire on a screen with nothing to advance.
  //
  // Live notification of the other party acting is worth having, and this was
  // not it. If it is built, it belongs on the agreement screen and keyed to
  // the agreement being viewed — see HANDOFF.md.


  useEffect(() => {
    if (!isRuntimeHydrated) return;

    const timer = setTimeout(() => {
      saveRuntimeSnapshot({
        hasOnboarded,
        mode,
        view,
        selectedItem,
        byocForm,
        activityLog,
      }, actorId);
    }, 900);

    return () => clearTimeout(timer);
  }, [
    isRuntimeHydrated,
    hasOnboarded,
    mode,
    view,
    selectedItem,
    byocForm,
    activityLog,
  ]);



  // id uses crypto.randomUUID(), not Date.now() — two toasts fired within the
  // same millisecond used to share an id, so the first one's removal timeout
  // (filter(t => t.id !== id)) removed both, and duplicate React keys showed
  // up in ToastContainer/activity-log lists.
  /**
   * The screens a counterparty reaches by following a link.
   *
   * They have no account, no contracts of their own, and nothing to switch
   * to. A blind review of these screens (2026-11-05) read the header's
   * command bar, "Sign in", "SWITCH TO HIRE" and the activity badge as
   * template filler, and "PROFESSIONAL" beside an invitation as a hint that
   * the reader was the one being hired — which they were not. Chrome that
   * belongs to the operator is not neutral on a stranger's screen: it
   * describes a product they are not in, next to the one decision they came
   * to make.
   *
   * The agreement screen is included only when it was opened with a guest
   * credential; the owner's own view of the same screen keeps everything.
   */
  const onGuestSurface = GUEST_SURFACE_VIEWS.has(view)
    || (view === 'agreement' && agreement?.source === 'guest');

  const addToast = useCallback((title, message, type = 'info') => { const id = crypto.randomUUID(); setToasts(prev => [...prev, { id, title, message, type }]); setActivityLog(prev => [{ id, title, message, type, timestamp: new Date() }, ...prev].slice(0, 50)); setUnreadCount(prev => prev + 1); setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000); }, []);

  const toggleMode = () => {
    if (status !== 'idle') return;
    setStatus('switching');
    setTimeout(() => {
        setMode(prev => { const newMode = prev === 'earner' ? 'hirer' : 'earner'; setView('home'); return newMode; });
        setSelectedItem(null);
        setStatus('idle');
        addToast('Mode Switched', `Active Interface: ${mode === 'earner' ? 'Client (Hirer)' : 'Professional (Earner)'}`);
    }, 800);
  };


  // Lands on the real home screen, named rather than inherited. Dismissing the
  // overlay used to reveal whatever `view` happened to hold, which on a first
  // visit is 'home' already — but a snapshot restore resolves asynchronously
  // and could still arrive afterwards, so the intended destination is stated
  // here instead of depending on which of the two lands last.
  const handleOnboardingComplete = useCallback(() => {
    localStorage.setItem('tf_onboarded', '1');
    setHasOnboarded(true);
    setView('home');
  }, []);

  // Signing in or out swaps which rows RLS will return, so both re-read.
  const handleSignedIn = useCallback(async () => {
    const state = await getAuthState();
    setAuth(state);
    setView('home');
    await refreshContracts();
    addToast('Signed in', 'Your contracts are back.', 'success');
  }, [refreshContracts, addToast]);

  const handleSignOut = useCallback(async () => {
    await signOutEarner();
    setAuth({ status: 'anonymous', email: null, userId: null });
    setMyContracts([]);
    setView('home');
    addToast('Signed out', 'This browser no longer holds your session.', 'info');
  }, [addToast]);

  const handleBYOCStart = useCallback(() => {
    // It used to reserve a client-side UUID here. Nothing reads it: the
    // contract id comes back from the server in persistContractAndLink, and
    // the only consumer of the reserved one was the legacy mock item.
    setShowBYOCForm(true);
  }, []);

  /**
   * Turn raw event rows into the shape the agreement record renders.
   *
   * The owner reads events straight from PostgREST under the party-scoped
   * SELECT policy; the guest gets an already-shaped response from
   * guest-contract-events. This normalises the first into the second so one
   * component serves both rather than two screens drifting apart.
   */
  const shapeOwnerEvents = useCallback((rows, contract) => {
    const performerIsCreator = (contract.performed_by ?? 'creator') === 'creator';
    return [...(rows ?? [])]
      .filter(ev => ev.type !== 'runtime.snapshot')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(ev => {
        const byCreator = ev.actor_id === contract.earner_user_id
          || (ev.actor_id && !String(ev.actor_id).startsWith('guest:'));
        return {
          id: ev.id,
          type: ev.type,
          created_at: ev.created_at,
          actorLabel: byCreator
            ? 'by you'
            : `by ${String(ev.actor_id ?? '').replace(/^guest:/, '') || 'the other party'}`,
          reason: ev.payload?.reason ?? ev.payload?.note ?? null,
          _performerIsCreator: performerIsCreator,
        };
      });
  }, []);

  /** Open a database-backed agreement as its owner. */
  // Read on every render of the home view rather than held in state: the list
  // changes when an acceptance writes a credential, and a stale copy would
  // hide the agreement a guest has just joined — which is the exact failure
  // this exists to fix.
  const guestAgreements = view === 'home'
    ? listGuestAgreementIds().map(id => ({ id, label: getGuestAgreementLabel(id) }))
    : [];

  const openContractFromHome = useCallback(async (contract) => {
    setAgreementError(null);
    setAgreement({ contract, events: [], role: performsHere(contract) ? 'performer' : 'receiver',
      // The account that owns the agreement. Only this side can read the raw
      // event rows, and therefore only this side can be offered an export.
      source: 'owner' });
    setView('agreement');
    let rows;
    try {
      rows = await fetchContractEvents(contract.id);
    } catch (err) {
      // An unreadable log is not an empty one. Saying nothing here would show
      // the owner an agreement with no history, which is the same screen a
      // brand-new contract gets.
      console.warn('[TrustFlow] contract events fetch failed:', err);
      setAgreementError('The history of this agreement could not be read. Nothing has been lost — try opening it again.');
      return;
    }
    setAgreement(prev => (prev?.contract?.id === contract.id
      ? { ...prev, events: shapeOwnerEvents(rows, contract) }
      : prev));
  }, [shapeOwnerEvents]);

  /** Open the same agreement as the invited counterparty, with no account. */
  const openAgreementAsGuest = useCallback(async (contractId, tokenOverride = null) => {
    setAgreementError(null);
    setAgreement(null);
    setView('agreement');
    const { evidence, reason } = await fetchGuestEvidence(contractId, tokenOverride);
    if (!evidence) {
      // Named individually, because the three say different things to the
      // person reading them: nothing here to open, a link that has been
      // replaced or was never real, and one that has simply aged out. Lumping
      // them into "could not be loaded" left a guest unable to tell whether
      // to ask for a new link or to try again later.
      setAgreementError({
        no_credential:        'This browser does not hold a credential for this agreement.',
        invalid_guest_token:  'This access link is not valid. It may have been replaced by a newer one.',
        guest_token_expired:  'This access link has expired.',
      }[reason] ?? 'The agreement could not be loaded.');
      return;
    }
    // Arriving on a re-issued link: the credential came in the URL and the
    // contract it belongs to is only known once the server has answered, so
    // it is filed now. From here this browser behaves like the one that
    // accepted — the link does not have to be kept.
    if (tokenOverride && evidence.contract?.id) {
      storeGuestAccessToken(String(evidence.contract.id), tokenOverride,
        evidence.contract?.project_name ?? null);
    }
    setAgreement({
      // A guest has no auth.users row, so RLS gives them nothing from `events`
      // directly — their trail comes shaped from guest-contract-events, with
      // each payload allowlist-filtered.
      //
      // This comment used to end "they cannot recompute a hash from that".
      // That stopped being true when the response gained a `canonical` block
      // per event: a guest CAN recompute each event hash and follow the chain.
      // What they cannot reproduce is `payload_hash`, because it is one digest
      // over the whole payload and they are shown an allowlisted part of it.
      // Corrected 2026-11-06 after Codex found the same stale claim in three
      // places. The unshaped response is kept because the
      // document is built from it, not from the array this screen renders.
      source: 'guest',
      evidence,
      contract: evidence.contract,
      // The shaped response already names the actor in readable terms.
      events: (evidence.events ?? []).map(ev => ({
        id: ev.id,
        type: ev.type,
        created_at: ev.created_at,
        actorLabel: ev.actor.role === 'guest_hirer' ? 'by you' : `by ${ev.actor.label}`,
        reason: ev.payload?.reason ?? ev.payload?.note ?? null,
      })),
      role: evidence.contract.viewer_role ?? 'receiver',
    });
  }, []);

  // A counterparty arriving on a re-issued link. This is the only way back in
  // for a guest whose browser no longer holds their credential: the invite is
  // single-use and spent, no email carries a link, and nothing else opens this
  // view. Declared after openAgreementAsGuest because it depends on it.
  //
  // The token is read once, filed under the contract the server resolves it
  // to, and then stripped from the address bar — leaving a live credential in
  // the URL would put it in history, in the next screenshot, and in any link
  // the guest pastes to ask someone what this is.
  useEffect(() => {
    const token = initialParams.get('guest');
    if (!token) return;
    // Only this parameter is removed, so a link that also carried others does
    // not quietly lose them.
    const url = new URL(window.location.href);
    url.searchParams.delete('guest');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    openAgreementAsGuest('', token);
  }, [initialParams, openAgreementAsGuest]);

  /**
   * Hand the party a self-contained, re-verifiable copy of their record.
   *
   * Deliberately re-fetches the raw event rows rather than exporting what the
   * screen is showing. `agreement.events` has been through shapeOwnerEvents,
   * which drops the hashes and reduces each payload to what the UI renders —
   * building the document from that would recompute payload hashes over
   * truncated payloads and report every untouched event as tampered with. An
   * evidence export that falsely cries tampering is worse than none.
   */
  const exportAgreementRecord = useCallback(async () => {
    const contract = agreement?.contract;
    if (!contract?.id) return;
    // A read failure throws EventReadError of its own, so reaching the next
    // line means the log really is empty rather than unread.
    const rows = await fetchContractEvents(contract.id);
    // An export with nothing in it would still look like a signed record.
    if (rows.length === 0) throw new Error('no events to export for this contract');
    await downloadAuditTrail({
      contractId: contract.id,
      dodHash: rows.find(ev => ev.dod_hash)?.dod_hash ?? null,
      events: rows.filter(ev => ev.type !== 'runtime.snapshot'),
      meta: {
        project_name: contract.project_name ?? null,
        offered_by: contract.earner_display_name ?? null,
        counterparty: contract.hirer_email ?? null,
        exported_by_role: agreement?.role ?? null,
      },
    });
    // Same reason as the guest export below: a download is invisible in-page,
    // and what is observed is the request, not the save.
    addToast('Download started — check your browser downloads', 'success');
  }, [agreement, addToast]);

  /**
   * Hand the counterparty the server-verified copy of their record.
   *
   * Built from the unshaped guest-contract-events response, not from
   * `agreement.events`, for the same reason the owner's export re-fetches: the
   * screen's array has lost the integrity verdicts this document reports. It is
   * deliberately a different artefact from the owner's — the guest's payloads
   * are allowlist-filtered, so a document inviting recomputation would report
   * every untouched event as tampered with.
   */
  const exportGuestRecord = useCallback(async () => {
    const evidence = agreement?.evidence;
    if (!evidence) throw new Error('no evidence loaded for this agreement');
    await downloadGuestRecord(evidence);
    // A browser download gives no in-page signal, so pressing the button and
    // pressing a dead button look identical. A blind counterparty pressed it
    // and reported it did nothing, on the screen that had just told it the
    // file was theirs to keep (2026-11-06).
    //
    // "saved to your downloads" was the first wording and it was false: the
    // export builds a Blob and clicks an anchor, and nothing here observes
    // whether the browser saved it, cancelled it, or put it anywhere in
    // particular. Claiming the save is the same defect this screen was being
    // fixed for. Codex, the same day.
    addToast('Download started — check your browser downloads', 'success');
  }, [agreement, addToast]);

  /**
   * Record a performance statement. The server decides whether this party may
   * make it — the screen only offers the action that belongs to the viewer, and
   * a refusal here means the two disagree, which is worth showing.
   */
  /**
   * Give the counterparty a working credential again.
   *
   * Returns the link rather than sending it: there is no mail path for this
   * (send-acceptance-email is deleted), and the owner already has whatever
   * channel they used for the invite. The agreement is re-read afterwards so
   * the access.reissued event appears without a manual refresh — the record
   * showing that access changed hands is the point, not a side effect.
   */
  const reissueAccess = useCallback(async () => {
    const contract = agreement?.contract;
    if (!contract?.id) return null;
    const { token, reason } = await reissueGuestAccess(contract.id);
    if (!token) {
      throw new Error(reason === 'not_accepted'
        ? 'Nobody has accepted this agreement yet — share the invite link instead.'
        : reason === 'not_the_owner'
          ? 'Only the owner of this agreement can re-issue access.'
          : 'Access could not be re-issued. Try again in a moment.');
    }
    // The re-issue itself already succeeded, so a failed re-read must not be
    // reported as a failed re-issue: return the link and leave the events as
    // they were.
    try {
      const rows = await fetchContractEvents(contract.id);
      setAgreement(prev => (prev?.contract?.id === contract.id
        ? { ...prev, events: shapeOwnerEvents(rows, contract) }
        : prev));
    } catch (err) {
      console.warn('[TrustFlow] contract events fetch failed:', err);
    }
    return guestAccessUrlFor(token);
  }, [agreement, shapeOwnerEvents]);

  const recordAgreementEvent = useCallback(async (type, payload = {}) => {
    const contract = agreement?.contract;
    if (!contract) return;
    setAgreementBusy(true);
    setAgreementError(null);
    const result = await logEvent({ type, contractId: contract.id, actorId, payload });
    setAgreementBusy(false);

    if (result?.persisted === false) {
      setAgreementError(result.persist_error === 'wrong_party_for_event_type'
        ? 'That action belongs to the other party.'
        : 'That could not be recorded. Try again in a moment.');
      return;
    }

    // State is projected from the log, so re-read rather than guessing at it.
    if (agreement.role === 'receiver' && contract.viewer_role === undefined) {
      await refreshContracts();
    }
    const { contracts } = await listContracts();
    const fresh = contracts.find(c => c.id === contract.id);
    if (fresh) {
      // The event is already written at this point, so a failed re-read is a
      // stale screen, not a failed action — and saying nothing would be the
      // worst of the three, since the party would look for the event they just
      // recorded and not find it.
      let rows;
      try {
        rows = await fetchContractEvents(contract.id);
      } catch (err) {
        console.warn('[TrustFlow] contract events fetch failed:', err);
        setAgreementError('Your action was recorded, but this screen could not be refreshed. Reopen the agreement to see it.');
        return;
      }
      // Merged into what is already open, not rebuilt from the parts this
      // function happens to know about. Rebuilding dropped `source`, and the
      // screen decides from that alone whether to offer the export, the
      // invite link and the access re-issue — so recording any event made all
      // three vanish from the owner's own agreement until it was reopened.
      // Found in QA 2026-10-11, after Mark as delivered.
      //
      // The id guard is the other half: there are two awaits above this, and
      // whoever was on screen when it started may not be on screen now.
      setAgreement(prev => (prev?.contract?.id === contract.id
        ? { ...prev, contract: fresh, events: shapeOwnerEvents(rows, fresh) }
        : prev));
      setMyContracts(contracts);
    } else {
      // Guest path: no PostgREST access, so re-read the shaped response.
      await openAgreementAsGuest(contract.id);
    }
  }, [agreement, actorId, refreshContracts, shapeOwnerEvents, openAgreementAsGuest]);

  const copyInviteLink = useCallback(async (contract) => {
    if (!contract?.invite_token) return;
    const url = inviteUrlFor(contract.invite_token);
    try {
      await navigator.clipboard.writeText(url);
      addToast('Invite link copied', 'Send it to your client.', 'success');
    } catch {
      // Clipboard access can be refused outright (permissions, insecure
      // context). Showing the link is more use than a failure message.
      addToast('Copy the invite link', url, 'info');
    }
  }, [addToast]);

  /**
   * Remove a contract that was created but never sent or never accepted —
   * e.g. closing "New contract" without copying the link, or a test draft.
   * The server enforces the actual boundary (owner_delete_unaccepted_draft);
   * this only refreshes the list once it agrees to the delete.
   */
  const handleDeleteDraft = useCallback(async (contract) => {
    const { deleted, error } = await deleteDraftContract(contract.id);
    if (!deleted) {
      addToast('Could not delete', error?.message ?? 'Try again in a moment.', 'error');
      return;
    }
    addToast('Draft deleted', 'It never had an accepting party.', 'success');
    await refreshContracts();
  }, [addToast, refreshContracts]);

  // Persists the contract and turns the server-issued invite_token into a link.
  // Server-owned columns (state, invite_token, expiry, ...) are deliberately not
  // sent — the client no longer holds INSERT privilege on them.
  const persistContractAndLink = useCallback(async () => {
    const dodItems = byocForm.dod
      ? byocForm.dod.split('\n').map(line => line.trim()).filter(Boolean)
      : [];
    const canonical = buildDodCanonical({
      dodText: dodItems.join('\n'),
      hirerId: (byocForm.clientEmail || '').trim(),
      earnerId: (byocForm.earnerEmail || '').trim(),
      budgetPoints: String(parseInt(byocForm.amount, 10) || 0),
      deadline: byocForm.deadline || 'TBD',
    });
    const dodHash = await sha256(canonical);

    const { contract, error } = await createContract({
      earnerDisplayName: (byocForm.earnerName || '').trim(),
      projectName: (byocForm.description || '').trim(),
      dod: dodItems,
      dodHash,
      amountJpy: parseInt(byocForm.amount, 10) || 0,
      deadline: byocForm.deadline || null,
      invitedHirerEmail: (byocForm.clientEmail || '').trim(),
      performedBy: byocForm.performedBy === 'counterparty' ? 'counterparty' : 'creator',
    });

    if (error || !contract) {
      setOtpError(error?.message ?? 'Could not save the contract.');
      return false;
    }
    setInviteLink(inviteUrlFor(contract.invite_token));
    addToast('Contract created', 'Invite link is ready to send.', 'success');
    return true;
  }, [byocForm, addToast]);

  const handleSendInvite = useCallback(async () => {
    setOtpError(null);
    setOtpStage('busy');
    try {
      if (await isEarnerVerified()) {
        await persistContractAndLink();
        setOtpStage('idle');
        return;
      }
      // `updateUser({ email })` upgrades the CURRENT session into a permanent
      // account, so there has to be one. It is created here rather than on
      // load, which is the only place a captcha challenge can honestly appear:
      // the person is in front of a form they chose to fill in.
      const identity = await ensureActorIdentity(captchaToken);
      if (identity.source !== 'supabase-auth') {
        // Three different causes, and they must not share a sentence: no
        // challenge was shown because this build has none, a challenge was
        // shown and not completed, or the network failed. The first is a
        // misconfiguration and is not the reader's fault.
        setOtpError(
          !captchaConfigured()
            ? 'Could not start a session. This deployment may be missing its '
              + 'challenge configuration — the site owner needs to look at it.'
            : captchaToken
              ? 'Could not start a session. Check your connection and try again.'
              : 'Please complete the challenge below first.',
        );
        setOtpStage('idle');
        return;
      }
      setActorId(identity.actorId);

      const { error } = await requestEarnerVerification((byocForm.earnerEmail || '').trim());
      if (error) {
        setOtpError(describeAuthError(error) ?? error.message ?? 'Could not send the code.');
        setOtpStage('idle');
        return;
      }
      // A stale code left over from an earlier request looks like a valid
      // current one otherwise — reproduced 2026-09-27: re-requesting after
      // correcting a typo left the previous code sitting in the box, which
      // then failed as expired rather than looking like what it was, an old
      // answer to a question that had moved on.
      setOtpCode('');
      setOtpStage('code');
    } catch (err) {
      setOtpError(describeAuthError(err) ?? String(err?.message ?? err));
      setOtpStage('idle');
    }
  }, [byocForm, persistContractAndLink, captchaToken]);

  const handleVerifyEarnerCode = useCallback(async () => {
    setOtpError(null);
    setOtpStage('busy');
    const { error } = await verifyEarnerOtp((byocForm.earnerEmail || '').trim(), otpCode);
    if (error) {
      setOtpError(error.message ?? 'That code did not work.');
      setOtpStage('code');
      return;
    }
    const ok = await persistContractAndLink();
    setOtpStage(ok ? 'idle' : 'code');
  }, [byocForm, otpCode, persistContractAndLink]);


  // The deadline is optional, so an empty one is not an error — only a date
  // that has already passed is. Both values are YYYY-MM-DD, which compares
  // correctly as a string.
  const earliestDeadline = todayLocalISO();
  const deadlineIsPast = Boolean(byocForm.deadline) && byocForm.deadline < earliestDeadline;

  // The palette used to be where the legacy surface stayed reachable after it
  // left the primary nav — Marketplace, Command Center, Wallet, Trust Passport
  // and Chat each had an entry here, described as deliberate. That surface is
  // being removed (Decisions.md, 2026-11-05), so these are the doors being
  // closed first: the views still exist in the tree at this commit and are now
  // unreachable, which is what the next step measures.
  const commands = useMemo(() => [
      { id: 'home', label: 'Go to Contracts', icon: LayoutGrid, action: () => setView('home') },
      { id: 'new-contract', label: 'New contract', icon: UserPlus, action: () => handleBYOCStart() },
      { id: 'switch', label: `Switch to ${mode === 'earner' ? 'Hirer' : 'Earner'} Mode`, icon: RefreshCw, action: toggleMode },
  ], [mode, handleBYOCStart]);




  // Unified profile object merging static and dynamic user data.

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans selection:bg-indigo-500/30 overflow-x-hidden relative">
      <NeuralBackground />

      {!hasOnboarded && <OnboardingView onComplete={handleOnboardingComplete} />}

      <ToastContainer toasts={toasts} removeToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      {isCommandOpen && (
        <>
          {/* Overlay for command palette modal: semi-transparent, blur, background visible */}
          <div className="fixed inset-0 z-[100] bg-[#0a0f1a]/70 backdrop-blur-[6px] transition-opacity" onClick={() => setIsCommandOpen(false)} />
          <div className="fixed inset-0 z-[110] flex items-center justify-center">
            <div className="w-[540px] max-w-full bg-[#23263a] rounded-[36px] shadow-[0_16px_64px_0_rgba(79,70,229,0.55),0_2px_16px_0_rgba(0,0,0,0.25)] border border-indigo-500/30 p-12 flex flex-col items-center">
              <CommandPalette isOpen={true} onClose={() => setIsCommandOpen(false)} commands={commands} />
            </div>
          </div>
        </>
      )}

      {/* Activity Log Panel */}
      {showActivityLog && (
        <div className="fixed top-20 right-6 z-[90] w-80 max-h-[70vh] flex flex-col bg-[#0f172a]/95 backdrop-blur-xl border border-white/10 rounded-[28px] shadow-2xl overflow-hidden animate-fade-in-up">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-indigo-400" /><span className="text-sm font-black text-white">Activity Log</span></div>
            <button onClick={() => setShowActivityLog(false)} className="text-slate-500 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <div className="overflow-y-auto flex-1 p-3 space-y-2">
            {activityLog.length === 0 && <p className="text-xs text-slate-600 text-center py-6 font-bold">No activity yet.</p>}
            {activityLog.map(item => (
              <div key={item.id} className={`px-4 py-3 rounded-2xl border text-xs ${item.type === 'success' ? 'bg-emerald-900/20 border-emerald-500/20' : item.type === 'error' ? 'bg-rose-900/20 border-rose-500/20' : item.type === 'warning' ? 'bg-amber-900/20 border-amber-500/20' : 'bg-indigo-900/20 border-indigo-500/20'}`}>
                <p className="font-black text-white mb-0.5">{item.title}</p>
                <p className="text-slate-400">{item.message}</p>
                <p className="text-slate-600 mt-1">{item.timestamp.toLocaleDateString()} {item.timestamp.toLocaleTimeString()}</p>
              </div>
            ))}
          </div>
          {activityLog.length > 0 && (
            <div className="px-6 py-3 border-t border-white/5">
              <button onClick={() => setActivityLog([])} className="text-xs text-slate-600 hover:text-slate-400 transition-colors font-bold uppercase tracking-widest">Clear log</button>
            </div>
          )}
        </div>
      )}

      {/* BYOC Form Modal */}
      {showBYOCForm && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={e => { if (e.target === e.currentTarget) { setShowBYOCForm(false); setInviteLink(null); setInviteLinkCopied(false); } }}>
          <div className="bg-[#0f172a] border border-white/10 rounded-[36px] w-full max-w-md shadow-2xl animate-fade-in-up flex flex-col max-h-[92vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-10 pt-10 pb-2">
              <div>
                <h3 className="text-2xl font-black text-white mb-1">Work with someone you know</h3>
                <p className="text-slate-400 text-sm">They can review the terms before creating an account.</p>
              </div>
              <button onClick={() => { setShowBYOCForm(false); setInviteLink(null); setInviteLinkCopied(false); }} className="ml-4 mt-1 text-slate-500 hover:text-white transition-colors shrink-0" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Scrollable body */}
            <div className="overflow-y-auto px-10 py-6 space-y-4 flex-1">
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Who is doing the work?</label>
                <div className="flex gap-3">
                  {[
                    { value: 'creator', label: 'Me' },
                    { value: 'counterparty', label: 'The other person' },
                  ].map(option => {
                    const selected = (byocForm.performedBy ?? 'creator') === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => { setByocForm(f => ({ ...f, performedBy: option.value })); setInviteLink(null); }}
                        className={`flex-1 py-3 rounded-2xl font-bold text-sm border transition-all ${
                          selected
                            ? 'bg-white text-[#020617] border-white'
                            : 'bg-slate-800 text-slate-400 border-white/10 hover:text-white hover:border-white/20'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-600 mt-2">
                  Whoever does the work is the one who marks it delivered. The other person accepts
                  it or asks for a correction.
                </p>
              </div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Your name</label><input type="text" value={byocForm.earnerName ?? ''} onChange={e => { setByocForm(f => ({ ...f, earnerName: e.target.value })); setInviteLink(null); }} placeholder="Shown to your client" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Your email</label><input type="email" value={byocForm.earnerEmail ?? ''} onChange={e => { setByocForm(f => ({ ...f, earnerEmail: e.target.value })); setInviteLink(null); }} placeholder="We send you a code to confirm it" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Client email</label><input type="email" value={byocForm.clientEmail ?? ''} onChange={e => { setByocForm(f => ({ ...f, clientEmail: e.target.value })); setInviteLink(null); }} placeholder="Where this invite is addressed" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Project name</label><input type="text" value={byocForm.description} onChange={e => { setByocForm(f => ({ ...f, description: e.target.value })); setInviteLink(null); }} placeholder="e.g., Mobile app redesign — 3 screens" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Amount (¥ JPY)</label><input type="number" min="0" value={byocForm.amount} onChange={e => { setByocForm(f => ({ ...f, amount: e.target.value })); setInviteLink(null); }} placeholder="e.g., 300000" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
                {/* min only constrains the picker; a date can still be typed
                    straight into the field, so the value is checked as well and
                    Send Invite is blocked on it. A deadline that has already
                    passed would be frozen into the agreement at acceptance and
                    is not something to find out about afterwards. */}
                <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Deadline</label><input type="date" min={earliestDeadline} value={byocForm.deadline ?? ''} onChange={e => { setByocForm(f => ({ ...f, deadline: e.target.value })); setInviteLink(null); }} className={`w-full bg-slate-800 border rounded-2xl px-5 py-4 text-white outline-none transition-all ${deadlineIsPast ? 'border-amber-500/60 focus:border-amber-500' : 'border-white/10 focus:border-indigo-500/50'}`} />{deadlineIsPast && <p className="text-[11px] text-amber-400 mt-2">That date has already passed. Pick today or later.</p>}</div>
              </div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">What counts as complete <span className="normal-case font-normal text-slate-600">(one item per line)</span></label><textarea value={byocForm.dod} onChange={e => { setByocForm(f => ({ ...f, dod: e.target.value })); setInviteLink(null); }} placeholder={"Definitive Figma Library\nDark Mode Tokens\nAtomic Design Compliance"} className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all resize-none min-h-[90px] font-mono text-sm" /></div>
              {otpStage === 'code' && (
                <div className="bg-slate-800/60 border border-indigo-500/30 rounded-2xl px-5 py-4 space-y-3">
                  <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Confirm your email</p>
                  <p className="text-xs text-slate-400">We sent a code to {byocForm.earnerEmail}. Entering it links this browser to a permanent account, so your contracts stay reachable.</p>
                  {/* Not hardcoded to 6: Supabase's OTP length is a project
                      setting (6-10 digits), and this project's is currently
                      8. maxLength was silently truncating every code typed
                      or pasted here, making verification impossible. */}
                  {/* This project's OTP length is 8 (a project setting, kept
                      as-is rather than changed back to Supabase's 6-digit
                      default). */}
                  <input type="text" inputMode="numeric" maxLength={8} value={otpCode} onChange={e => setOtpCode(e.target.value)} placeholder="00000000" className="w-full bg-slate-900 border border-white/10 rounded-2xl px-5 py-4 text-white text-center text-2xl font-mono tracking-[0.4em] outline-none focus:border-indigo-500/50" />
                  <button onClick={handleVerifyEarnerCode} disabled={otpCode.trim().length < 8} className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-black text-sm transition-all">Confirm &amp; create contract</button>
                  <button
                    onClick={() => { setOtpStage('idle'); setOtpCode(''); setOtpError(null); }}
                    className="w-full py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    Use a different email
                  </button>
                </div>
              )}
              {/* The last moment any of this can be corrected.
                  Every field below is copied into the agreement snapshot and
                  covered by agreement_hash when the counterparty accepts, and
                  freeze_accepted_terms refuses to change them after that — so
                  a wrong value here is not a typo, it is a permanent record of
                  a deal nobody made. The fields are shown as the other side
                  reads them rather than as labelled inputs, because that is
                  what makes a wrong one obvious: on 2026-10-10 a dogfood run
                  put the project name into "Your name", and the record it
                  produced said the counterparty had dealt with a company named
                  after the project. Nothing in the form could have caught that
                  — the value was well-formed, just wrong — but seeing the two
                  side by side would have. */}
              {!inviteLink && (byocForm.earnerName ?? '').trim() && (byocForm.description ?? '').trim() && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 space-y-1.5">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Your client will see</p>
                  <p className="text-sm text-slate-300">
                    <span className="text-white font-bold">{byocForm.description.trim()}</span>
                    {' — offered by '}
                    <span className="text-white font-bold">{byocForm.earnerName.trim()}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {byocForm.amount ? `¥${Number(byocForm.amount).toLocaleString('en-US')}` : 'No amount'}
                    {' · '}
                    {byocForm.deadline ? `due ${byocForm.deadline}` : 'no deadline'}
                    {' · '}
                    {byocForm.performedBy === 'counterparty' ? 'they do the work' : 'you do the work'}
                  </p>
                  <p className="text-[11px] text-slate-600 pt-1">
                    These terms are locked once they accept. Check them now.
                  </p>
                </div>
              )}
              {otpError && (
                <p className="text-xs text-rose-400 font-bold px-1">{otpError}</p>
              )}
              {inviteLink && (
                <div className="bg-slate-800/60 border border-indigo-500/30 rounded-2xl px-5 py-4 space-y-3">
                  <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Invite Link — share this</p>
                  <p className="text-xs text-slate-400 break-all font-mono leading-relaxed">{inviteLink}</p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(inviteLink);
                      setInviteLinkCopied(true);
                      setTimeout(() => setInviteLinkCopied(false), 2000);
                    }}
                    className={`w-full py-3 rounded-2xl font-black text-sm transition-all ${
                      inviteLinkCopied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                    }`}
                  >
                    {inviteLinkCopied ? '✓ Copied!' : 'Copy Link'}
                  </button>
                </div>
              )}
            </div>
            {/* Sticky footer */}
            <div className="px-10 pb-10 pt-4 border-t border-white/5 flex flex-col gap-3">
              {otpStage !== 'code' && (
                <CaptchaChallenge onToken={setCaptchaToken} />
              )}
              <button
                onClick={handleSendInvite}
                disabled={
                  otpStage !== 'idle'
                  || !(byocForm.description ?? '').trim()
                  || !(byocForm.earnerName ?? '').trim()
                  || !(byocForm.earnerEmail ?? '').trim()
                  || !(byocForm.clientEmail ?? '').trim()
                  || deadlineIsPast
                }
                className="flex-1 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-black transition-all text-sm"
              >
                {otpStage === 'busy' ? 'Working…' : inviteLink ? 'Create another' : 'Send Invite'}
              </button>
              {/* "Start Myself →" stood here and ran handleBYOCSubmit, which
                  routes to the legacy scoping/ContractView flow — a door into
                  the removed surface inside a modal the evidence path needs.
                  Send Invite above is the one that creates a real contract. */}
            </div>
          </div>
        </div>
      )}

      {(status === 'processing' || status === 'switching') && (<div className="fixed inset-0 z-[100] bg-[#020617]/90 backdrop-blur-md flex flex-col items-center justify-center"><Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-6" /><p className="text-indigo-400 font-black tracking-[0.5em] text-[10px] uppercase animate-pulse">{status === 'switching' ? 'Reconfiguring Interface...' : 'Verifying Ledger...'}</p></div>)}

      {/* Header */}
      <nav aria-label="Primary" className="fixed top-0 left-0 right-0 z-50 bg-[#020617]/80 backdrop-blur-xl border-b border-white/[0.05] px-6 py-4 flex justify-between items-center transition-all duration-300">
        <div className="flex items-center gap-4 cursor-pointer group" onClick={() => setView('home')}>
          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-lg transition-colors ${mode === 'earner' ? 'bg-indigo-600' : 'bg-emerald-600'}`}>{mode === 'earner' ? <ShieldCheck className="text-white w-6 h-6" /> : <Briefcase className="text-white w-6 h-6" />}</div>
          <div className="hidden sm:block"><span className="font-black text-xl tracking-tighter text-white block leading-none">TRUSTFLOW</span>{!onGuestSurface && <span className="text-[9px] font-black text-slate-500 tracking-[0.3em] uppercase">{mode === 'earner' ? 'Professional' : 'Client Suite'}</span>}</div>
        </div>
        {!onGuestSurface && <div onClick={() => setIsCommandOpen(true)} className="hidden md:flex flex-1 max-w-md mx-6 items-center gap-3 bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 px-4 py-2.5 rounded-xl cursor-pointer transition-all group"><Search className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" /><span className="text-sm text-slate-500 group-hover:text-slate-300 transition-colors">Type a command...</span><div className="ml-auto flex gap-1"><span className="text-[10px] font-mono text-slate-600 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">⌘K</span></div></div>}
        <div className="flex gap-4 items-center">
          {/* Whose contracts these are, shown rather than hidden in a tooltip.
              The address was only ever in `title`, so it took a hover to find
              and did not exist at all on touch — and the whole control was
              `hidden sm:flex`, which left a phone with no way to sign out
              either. In a product about who agreed to what, the account you
              are acting as should never need looking up, and it is easy to
              lose track of while holding two of them. The address is the part
              that must survive a narrow screen, so the word "Sign out" is what
              gives way, not the identity. */}
          {onGuestSurface ? null : auth.status === 'signed_in' ? (
            <div className="flex items-center gap-1 pl-3.5 pr-1 py-1 rounded-full border border-white/10">
              <span
                className="text-xs font-bold text-slate-300 max-w-[120px] sm:max-w-[220px] truncate"
                title={auth.email ?? undefined}
              >
                {auth.email ?? 'Signed in'}
              </span>
              <button
                onClick={handleSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full hover:bg-white/5 transition-all text-xs font-bold text-slate-500 hover:text-white"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => setView('signin')}
              className="flex items-center gap-2 px-4 py-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all text-xs font-bold text-indigo-300"
            >
              <LogIn className="w-3.5 h-3.5" /> Sign in
            </button>
          )}
          {!onGuestSurface && <button onClick={toggleMode} className="flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 hover:bg-white/5 transition-all"><div className={`w-2 h-2 rounded-full ${mode === 'earner' ? 'bg-indigo-500' : 'bg-emerald-500'}`} /><span className="text-xs font-bold uppercase tracking-wider text-slate-300">Switch to {mode === 'earner' ? 'Hire' : 'Work'}</span><RefreshCw className="w-3 h-3 text-slate-500" /></button>}
          {/* The TrustPoints coin pill stood here and opened the Wallet. Both
              go with the reputation layer. */}
          {/* Command Center is no longer in the primary navigation — it was a
              second dashboard competing with the Contracts home. The view still
              exists; ⌘K reaches it. */}
          {!onGuestSurface && <button
            className={`hidden sm:inline-flex p-2 ml-1 rounded-full border border-white/10 transition-colors relative ${showActivityLog ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-400 hover:text-indigo-300 hover:bg-white/10'}`}
            title="Activity Log"
            onClick={() => { setShowActivityLog(prev => !prev); setUnreadCount(0); }}
          >
            <Activity className="w-5 h-5" />
            {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-indigo-500 rounded-full text-[9px] font-black text-white flex items-center justify-center leading-none">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>}
          {/* The profile avatar and the chat bell used to sit here. Both are
              gone, for the same reason the Command Center left the primary nav
              above: ⌘K still reaches "View Trust Passport" and "Toggle Chat".

              The avatar was not the signed-in account. It rendered
              USER_PROFILE.name[0] — a hardcoded fixture, "Felix", from the
              2026-02 marketplace prototype — so the letter was "F" for
              everyone, on every screen, beside the Sign in button, signed in
              or not, and for a guest reading someone else's record of
              agreement. A product whose only claim is recording who did what
              cannot assert the wrong account in its own header. That it merely
              failed to name the acting account was the 2026-10-11 finding; it
              was worse than that.

              The bell went with it: its unread dot was unconditional, and it
              was disabled below level 2 while advertising "Unlock Chat at
              Level 2" in text that overlapped the icon it belonged to. */}
        </div>
      </nav>

      <main className="pt-32 pb-32 max-w-6xl mx-auto px-6 relative z-10">
        {view === 'agreement' && (
          <AgreementView
            contract={agreement?.contract}
            events={agreement?.events}
            viewerRole={agreement?.role}
            busy={agreementBusy}
            error={agreementError}
            onAssertDelivery={(note) => recordAgreementEvent(EVENT_TYPES.PERFORMANCE_ASSERTED, { note })}
            onAccept={() => recordAgreementEvent(EVENT_TYPES.PERFORMANCE_ACCEPTED)}
            onRequestCorrection={(reason) =>
              recordAgreementEvent(EVENT_TYPES.PERFORMANCE_REJECTED, { reason })}
            onReportPayment={(note) =>
              recordAgreementEvent(EVENT_TYPES.PAYMENT_REPORTED, { note })}
            onAcknowledgePayment={() => recordAgreementEvent(EVENT_TYPES.PAYMENT_ACKNOWLEDGED)}
            onDisputePayment={(note) =>
              recordAgreementEvent(EVENT_TYPES.PAYMENT_DISPUTED, { note })}
            onExport={agreement?.source === 'owner' ? exportAgreementRecord
              : agreement?.source === 'guest' ? exportGuestRecord : undefined}
            exportKind={agreement?.source === 'guest' ? 'server_verified' : 'verifiable'}
            onCopyInvite={agreement?.source === 'owner' ? copyInviteLink : undefined}
            onReissueAccess={agreement?.source === 'owner' ? reissueAccess : undefined}
            onBack={() => { setAgreement(null); setView(auth.status === 'signed_in' ? 'home' : 'invite-accepted'); }}
          />
        )}
        {view === 'signin' && (
          <SignInView
            initialEmail={auth.email ?? ''}
            expired={auth.status === 'expired'}
            onRequestCode={(email) => requestSignInCode(email, captchaToken)}
            captchaSlot={<CaptchaChallenge onToken={setCaptchaToken} />}
            onVerifyCode={async (email, code) => {
              const result = await verifySignInCode(email, code);
              if (result.user) await handleSignedIn();
              return result;
            }}
            onBack={() => setView('home')}
          />
        )}
        {view === 'home' && (
          <ContractsHomeView
            contracts={myContracts}
            loading={contractsLoading}
            error={contractsError}
            onRetry={refreshContracts}
            onNewContract={handleBYOCStart}
            onOpenContract={openContractFromHome}
            onCopyInvite={copyInviteLink}
            onDeleteDraft={handleDeleteDraft}
            authStatus={auth.status}
            authEmail={auth.email}
            onSignIn={() => setView('signin')}
            guestAgreements={guestAgreements}
            onOpenGuestAgreement={openAgreementAsGuest}
          />
        )}
        {/* marketplace, project-detail and negotiation-chat rendered here.
            Removed with the legacy surface — Decisions.md, 2026-11-05. */}
        {view === 'invite' && inviteLoading && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-slate-500">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
            <p className="text-xs font-black uppercase tracking-[0.3em]">Loading agreement…</p>
          </div>
        )}
        {view === 'invite' && !inviteLoading && (inviteData || inviteTokenError) && (
          <InviteView
            inviteData={inviteData}
            tokenError={inviteTokenError}
            onAccept={async (guestName, email) => {
              // One server-side operation. It consumes the one-time token,
              // records the accepting identity, moves the contract to
              // TERMS_ACCEPTED and writes the acceptance evidence — all or
              // nothing. The client used to write that evidence itself in a
              // second call, which meant a dropped connection could leave an
              // accepted agreement with no record of what was accepted.
              // The captured query again: this runs on a click, long after an
              // effect could have rewritten the address bar.
              const raw = initialParams.get('token');
              const name = guestName || 'Guest';

              // WHAT THIS NARROWS, AND WHAT IT DOES NOT CLOSE
              // The acceptance request carries only the token. The server
              // re-reads the contract and hashes THAT row
              // (validate-invite-token/index.ts:135-149), so the snapshot
              // binds the terms as they stand at the click, not the terms on
              // screen. Its row_version guard covers only the server's own
              // read-to-write window. Between this screen loading and this
              // click — minutes, while someone reads — the owner can edit the
              // agreement, and the guest would be recorded as having accepted
              // terms they were never shown. Found by Codex's review of this
              // change, 2026-11-05.
              // Re-reading here and refusing on a difference shrinks that
              // window to one round trip. It does not remove it: the real fix
              // is for the acceptance request to carry the version the guest
              // saw and for the server to refuse a mismatch, which is an Edge
              // Function change and needs its own approval. Until then this is
              // a narrowing, not a guarantee — see HANDOFF.md.
              const shownDigest = await shownTermsDigest(inviteData);
              const { invite: current } = await fetchInvite(raw);
              if (current && (await shownTermsDigest(current)) !== shownDigest) {
                setInviteTokenError('terms_changed');
                setInviteData(null);
                return;
              }

              // The digest goes with the request as well: this check is a
              // courtesy that gives a clear screen without consuming the
              // invitation, while the server's own comparison is the guard.
              const { accepted, reason } = await acceptInvite(raw, email, name, shownDigest);
              if (!accepted) {
                setInviteTokenError(reason === 'already_used' ? 'already_used' : reason);
                setInviteData(null);
                return;
              }

              const contractId = accepted.contract_id;
              // The guest Hirer's credential for this contract. Without it the
              // log-event function has no way to tell this browser apart from
              // any other, and the acceptance record below is rejected.
              // The name travels with the credential so the list of accepted
              // agreements can say what each one is. A counterparty holding
              // three of them could not tell which was which (2026-11-06).
              storeGuestAccessToken(contractId, accepted.guest_access_token, accepted.project_name);
              setSelectedItem({
                id: contractId,
                title: accepted.project_name,
                client: accepted.earner_display_name ?? 'Your counterparty',
                totalPoints: accepted.amount_jpy ?? 0,
                acceptanceCriteria: accepted.dod ?? [],
                deadline: accepted.deadline ?? null,
              });
              // The claimed name and email were also held in state here. Only
              // the legacy ContractView read them; what matters about both is
              // already recorded server-side in the acceptance event, which is
              // the copy a dispute would rely on.
              window.history.replaceState({}, '', window.location.pathname);
              setView('invite-accepted');
              // No qualification needed any more. The response exists only
              // because the acceptance and its evidence committed together.
              addToast('Agreement accepted', 'Your acceptance has been recorded.', 'success');
            }}
            onDecline={() => {
              // Declining used to clear the URL and drop straight onto the
              // app's home screen. A blind counterparty did exactly that and
              // reported "断れたのか分からない" — no acknowledgement, and for
              // a browser that happens to hold a session, the operator's own
              // contract list (2026-11-06).
              //
              // Nothing is written: a refusal is not an act on the agreement,
              // the invitation stays unconsumed, and recording "someone
              // declined" would be an assertion nobody made. So the honest
              // close is to say what did and did not happen, and to leave the
              // link working — reconsidering is the common case, and this is
              // the only way back.
              // The URL and the loaded invitation are deliberately KEPT. The
              // screen tells the reader the link still works, and clearing
              // either would make that false — a reload would land on an app
              // they have no account for.
              setView('invite-declined');
            }}
          />
        )}
        {view === 'invite-declined' && (
          <div className="max-w-lg mx-auto text-center space-y-6 py-20 animate-fade-in-up">
            <div className="w-16 h-16 rounded-[20px] bg-white/5 border border-white/10 flex items-center justify-center mx-auto">
              <XCircle className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-3xl font-black tracking-tighter text-white">You did not accept</h2>
            {/* Says what did NOT happen, because that is what the reader is
                uncertain about. A blind counterparty declined and could not
                tell whether anything had been sent, recorded or used up. */}
            {/* Said "Nothing was recorded and nothing was sent", which is
                false as written: changing view saves a runtime snapshot, and
                that snapshot is upserted to the server (runtimeState.js). The
                true, narrower claim is about the AGREEMENT — declining adds
                no event to it and consumes nothing. Codex caught the
                over-reach, 2026-11-06.

                "this link still works" was also unconditional. Declining does
                not spend the invitation; expiry, withdrawal by the sender, or
                an acceptance in another tab still can. */}
            <p className="text-slate-400 text-sm leading-relaxed">
              Nothing was added to the agreement, and declining does not use up
              this invitation — so you can come back to it while it is still
              valid.
            </p>
            <p className="text-xs text-slate-400 leading-relaxed border border-white/5 bg-white/[0.02] rounded-2xl px-5 py-4">
              Whoever sent it is <span className="text-slate-300">not told</span> that
              you looked or that you declined — TrustFlow sends no mail. If you
              want them to know, tell them the way they reached you.
            </p>
            <button
              onClick={() => setView('invite')}
              className="text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors"
            >
              Look at the terms again
            </button>
          </div>
        )}
        {view === 'invite-accepted' && (
          <div className="max-w-lg mx-auto text-center space-y-6 py-20 animate-fade-in-up">
            <div className="w-16 h-16 rounded-[20px] bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-3xl font-black tracking-tighter text-white">Agreement accepted</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your acceptance of <span className="text-white font-bold">{selectedItem?.title}</span> has been
              timestamped and recorded.
            </p>
            {/* Two false statements stood here. "{client} has been notified"
                was not true of anything: send-acceptance-email was deleted on
                2026-09-26, invitation and access links are delivered by hand,
                and the live subscription went with the legacy surface — so
                nobody is told. And "for now"/"yet" described a permanent
                design (money moves outside TrustFlow, Decisions.md) as a
                temporary state, which reads as a product about to change
                under someone who has just committed. */}
            <p className="text-xs text-slate-400 leading-relaxed border border-white/5 bg-white/[0.02] rounded-2xl px-5 py-4">
              TrustFlow does not process the payment for this agreement, and sends{' '}
              {selectedItem?.client} no notification that you accepted — reach them the
              way they reached you. Either of you can then record that a payment was sent or
              received, which TrustFlow stores as your statement rather than as a
              fact it checked.
            </p>
            <button
              onClick={() => openAgreementAsGuest(String(selectedItem?.id ?? ''))}
              className="px-6 py-3 rounded-2xl bg-white text-[#020617] font-black text-sm hover:bg-indigo-400 hover:text-white transition-all"
            >
              Open this agreement
            </button>
            <button
              onClick={async () => {
                const contractId = String(selectedItem?.id ?? '');
                setGuestEvidence(null);
                setGuestEvidenceReason(null);
                setView('guest-evidence');
                const { evidence, reason } = await fetchGuestEvidence(contractId);
                setGuestEvidence(evidence);
                setGuestEvidenceReason(reason);
              }}
              className="block mx-auto text-xs text-slate-500 hover:text-slate-300 underline underline-offset-4 transition-colors"
            >
              View the full verification detail
            </button>
          </div>
        )}
        {view === 'guest-evidence' && (
          <GuestEvidenceView
            evidence={guestEvidence}
            reason={guestEvidenceReason}
            onExport={guestEvidence ? async () => {
              try {
                await downloadGuestRecord(guestEvidence);
              } catch (err) {
                // The same evidence object the screen is rendering, so this
                // fails only if the document builder rejects it — worth
                // saying out loud rather than a button that does nothing.
                addToast('Download failed', err?.message ?? 'The record could not be written.', 'error');
              }
            } : undefined}
            onBack={() => setView('invite-accepted')}
          />
        )}
        {/* scoping and the five-step ContractView rendered here. */}
        {/* The LEVEL UP / +1 PARAMETER overlays rendered here. They read
            state that nothing set any more: the only triggers were in the
            removed five-step flow, so a name-occurrence scan called them
            used and they could never appear. */}
        {/* wallet and command-center rendered here. */}

      </main>

      {/* Hidden on a guest surface: its single button goes to the operator's
          contracts list, which a counterparty has no account for, and at phone
          width the bar covered the completion criteria on the invitation and
          the timeline on the record (blind review, 2026-11-05). */}
      {!onGuestSurface && <nav aria-label="Primary, compact" className="sm:hidden fixed bottom-0 left-0 right-0 bg-[#0F172A]/80 backdrop-blur-2xl border-t border-white/10 px-8 py-5 flex justify-center items-center z-50 shadow-[0_-15px_40px_rgba(0,0,0,0.6)]">
        <button title="Contracts" className={`p-3 transition-all duration-300 ${view === 'home' ? 'text-indigo-400 scale-125 bg-indigo-500/10 rounded-2xl shadow-[0_0_20px_rgba(99,102,241,0.2)]' : 'text-slate-500 hover:text-slate-300'}`} onClick={() => { setIsCommandOpen(false); setView('home'); }}><LayoutGrid className="w-6 h-6" /></button>
        {/* The Wallet button and the profile avatar stood here. The avatar was
            the same hardcoded "F" the desktop header carried, and it survived
            bd33c34 because that change only touched the header and every frame
            reviewed for it was desktop-width — the mobile bar is sm:hidden.
            Recorded as the method's blind spot in HANDOFF.md. */}
      </nav>}

      <style>{`
        body { background-color: #020617; margin: 0; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in-up { animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        .animate-slide-in-right { animation: slideInRight 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes scaleUp { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        .animate-scale-up { animation: scaleUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fall { to { transform: translateY(100vh) rotate(720deg); } }
        .animate-fall { animation: fall linear forwards; }
        @keyframes scan { 0% { top: 0; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
        .animate-scan { animation: scan 3s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
        @keyframes scanVertical { 0% { top: 0; opacity: 0; } 50% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
        .animate-scan-vertical { animation: scanVertical 1.5s linear infinite; }
      `}</style>
    </div>
  );
};

export default App;