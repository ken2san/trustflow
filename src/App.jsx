import NegotiationChatView from './views/NegotiationChatView';

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


import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { initialUIProfileStats, initialInternalProfileStats } from './lib/profileInitialData';
import { FEATURE_UNLOCKS } from './lib/featureUnlocks';
import {
  ShieldCheck, ArrowRight, Lock, Unlock, CheckCircle2, AlertCircle,
  MessageSquare, Wallet, Coins, PlusCircle, Search, Sparkles, Zap,
  ArrowLeft, ListChecks, Activity, TrendingUp, Globe, Award,
  BadgeCheck, UploadCloud, X, Send, Paperclip, Fingerprint, Scale,
  BrainCircuit, Target, UserCheck, LayoutGrid, Bell, CreditCard,
  Loader2, Check, MousePointer2, FileSignature, Scan, Hash,
  RefreshCw, QrCode, Briefcase, Users, ChevronRight, User, Gavel, AlertTriangle,
  Command, Laptop, Wand2, MapPin, Calendar, Share2, Hexagon, BarChart4, Star,
  Layers, UserPlus, LogIn, LogOut
} from 'lucide-react';
// Returns a unified profile object merging static and dynamic user data
// (moved below imports)

// Centralized constants and mock data
import { USER_PROFILE, JOBS_DATA, TALENTS_DATA } from './lib/constants';
import { formatNumber, deriveLevel } from './lib/utils';
import { sha256, buildDodCanonical } from './lib/crypto.js';
import { logEvent, EVENT_TYPES, fetchContractEvents, subscribeToContractEvents } from './lib/eventLog.js';
import { downloadAuditTrail } from './lib/auditExport.js';
import { downloadGuestRecord } from './lib/guestRecordExport.js';
import { loadRuntimeSnapshot, saveRuntimeSnapshot } from './lib/runtimeState.js';
import { ensureActorIdentity } from './lib/identity.js';
import { createContract, listContracts, inviteUrlFor, fetchInvite, acceptInvite, fetchGuestEvidence } from './lib/contracts.js';
import { storeGuestAccessToken } from './lib/guestSession.js';
import {
  requestEarnerVerification, verifyEarnerOtp, isEarnerVerified,
  requestSignInCode, verifySignInCode, getAuthState, signOutEarner,
} from './lib/earnerAuth.js';
import { supabase, isSupabaseEnabled } from './lib/supabase.js';


// ...existing code...


/* ========================================================================
   2. CUSTOM HOOKS
   ======================================================================== */


// useInterval moved to hooks/useInterval.js
import useInterval from './hooks/useInterval';

/* ========================================================================
   3. UI COMPONENTS (ATOMS & MOLECULES)
   ======================================================================== */

// NeuralBackground moved to components/ui/NeuralBackground.jsx
import NeuralBackground from './components/ui/NeuralBackground';

// SpotlightCard moved to components/ui/SpotlightCard.jsx
import SpotlightCard from './components/ui/SpotlightCard';

// HoldButton moved to components/ui/HoldButton.jsx
import HoldButton from './components/ui/HoldButton';


// ScrambleText moved to components/ui/ScrambleText.jsx
import ScrambleText from './components/ui/ScrambleText';


// ToastContainer moved to components/ui/ToastContainer.jsx
import ToastContainer from './components/ui/ToastContainer';


/* ========================================================================
   4. FEATURE MODALS
   ======================================================================== */


// ProfileModal moved to components/modals/ProfileModal.jsx
import ProfileModal from './components/modals/ProfileModal';

// CommandPalette component for command modal
import CommandPalette from './components/ui/CommandPalette.jsx';




// DisputeModal moved to components/modals/DisputeModal.jsx
import DisputeModal from './components/modals/DisputeModal';


// PaymentModal moved to components/modals/PaymentModal.jsx
import PaymentModal from './components/modals/PaymentModal';



// --- Page Views ---

// OnboardingView moved to views/OnboardingView.jsx
import OnboardingView from './views/OnboardingView';

// MarketplaceView moved to views/MarketplaceView.jsx
import MarketplaceView from './views/MarketplaceView';

// ScopingView moved to views/ScopingView.jsx
import ScopingView from './views/ScopingView';

// ContractView moved to views/ContractView.jsx
import ContractView from './views/ContractView';

// WalletView moved to views/WalletView.jsx
import WalletView from './views/WalletView';
import GuestEvidenceView from './views/GuestEvidenceView';
import ContractsHomeView from './views/ContractsHomeView';
import SignInView from './views/SignInView';
import AgreementView from './views/AgreementView';
import { performsHere } from './lib/contractStatus.js';

// CommandCenterView moved to views/CommandCenterView.jsx
import CommandCenterView from './views/CommandCenterView';

// ProjectDetailView moved to views/ProjectDetailView.jsx
import ProjectDetailView from './views/ProjectDetailView';

// InviteView for counterparty invite link flow
import InviteView from './views/InviteView';

// --- Main App Component ---

const App = () => {
  // Centralized Acceptance Protocol state (DoD/terms)
  const [acceptanceProtocol, setAcceptanceProtocol] = useState([
    'Definitive Figma Library',
    'Dark Mode Tokens',
    'Atomic Design Compliance'
  ]);
  // Centralized chat lock state
  const [chatLocked, setChatLocked] = useState(false);
    // Negotiation chat state (shared for evidence/dispute)
    const [negotiationMessages, setNegotiationMessages] = useState([
      { sender: "client", text: "Thank you for your interest. Our initial budget is 3,000,000 for the full design system.", time: "09:00" },
      { sender: "me", text: "Thank you. Can you clarify the scope for dark mode and atomic design compliance?", time: "09:02" },
      { sender: "client", text: "Dark mode should cover all screens. Atomic design compliance is required for component structure.", time: "09:05", important: true },
    ]);
    const [negotiationAgreed, setNegotiationAgreed] = useState(false);
  // Animation state for level/parameter up
  const [showLevelUp, setShowLevelUp] = useState(false);
  const [showParamUp, setShowParamUp] = useState(false);

  // Animation triggers
  const triggerLevelUp = useCallback(() => {
    setShowLevelUp(true);
    setTimeout(() => setShowLevelUp(false), 1800);
  }, []);
  const triggerParamUp = useCallback(() => {
    setShowParamUp(true);
    setTimeout(() => setShowParamUp(false), 1200);
  }, []);

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
  const [inviteLoading, setInviteLoading] = useState(() =>
    new URLSearchParams(window.location.search).has('token'));
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
  const [view, setView] = useState(() =>
    new URLSearchParams(window.location.search).has('token') ? 'invite' : 'home');
  // Who this browser is acting as: 'signed_in', 'anonymous' or 'expired'.
  // Resolved on load from the persisted session — supabase-js restores and
  // refreshes it itself, so this only has to report what it found.
  const [auth, setAuth] = useState({ status: 'anonymous', email: null, userId: null });
  // The signed-in Earner's own contracts, read straight from the database.
  const [myContracts, setMyContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(true);
  const [contractsError, setContractsError] = useState(null);
  const [step, setStep] = useState(1);

  // UI profile state
  const [uiProfile, setUIProfile] = useState(initialUIProfileStats);
  // Internal profile state
  const [internalProfile, setInternalProfile] = useState(initialInternalProfileStats);

  // --- Feature Unlock Progress State ---
  // Option 1: Just use level from uiProfile, but allow for future extensibility
  const userLevel = uiProfile.level || 1;
  // Compute unlocked features (flattened array of feature keys)
  const unlockedFeatures = FEATURE_UNLOCKS
    .filter(fu => fu.level <= userLevel)
    .flatMap(fu => fu.features.map(f => f.key));
  // Compute locked features (flattened array of {key, label, level})
  const lockedFeatures = FEATURE_UNLOCKS
    .filter(fu => fu.level > userLevel)
    .flatMap(fu => fu.features.map(f => ({ ...f, level: fu.level })));

  const [selectedItem, setSelectedItem] = useState(null);
  const [status, setStatus] = useState('idle');
  // Add projectDetail state for Project Detail & Negotiation flow
  const [projectDetail, setProjectDetail] = useState(null);
  const lastActionTime = useRef(0); // Safety guard for global transitions

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [scrambleTrigger, setScrambleTrigger] = useState(0);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isBiometricOpen, setIsBiometricOpen] = useState(false);
  const [isDisputeOpen, setIsDisputeOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Phase 4: append-only contract event log (persisted to Supabase when connected)
  const [contractEvents, setContractEvents] = useState([]);
  const [dodHash, setDodHash] = useState(null);
  // Phase 4: permanent bad-actor flags — persist across contract cycles
  const [badActorFlags, setBadActorFlags] = useState([]);
  const [contractHistory, setContractHistory] = useState([]);
  const [isRehire, setIsRehire] = useState(false);
  const [hasOnboarded, setHasOnboarded] = useState(() => {
    if (new URLSearchParams(window.location.search).has('reset')) {
      localStorage.removeItem('tf_onboarded');
      return false;
    }
    return !!localStorage.getItem('tf_onboarded');
  });
  const [showBYOCForm, setShowBYOCForm] = useState(false);
  const [byocForm, setByocForm] = useState({ name: '', description: '', amount: '', dod: '' });
  const [byocContractId, setByocContractId] = useState('');
  const [inviteLink, setInviteLink] = useState(null);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  // Earner verification (A-1): the contract is only persisted once the Earner
  // has proved an email, so a cleared browser cannot orphan a real agreement.
  const [otpStage, setOtpStage] = useState('idle'); // 'idle' | 'busy' | 'code'
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState(null);
  const [guestName, setGuestName] = useState(null); // set when counterparty joins via invite link
  const [guestEmail, setGuestEmail] = useState(null); // optional email from invite Stage 2
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

  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [trustPointsLedger, setTrustPointsLedger] = useState([]);
  const [activePaymentIntentId, setActivePaymentIntentId] = useState(null);

  const [messages, setMessages] = useState([{ id: 1, sender: 'ai', text: 'Protocol initialized. DoD generated based on risk profile.', time: '10:00', type: 'text' }, { id: 2, sender: 'client', text: 'Looking forward to the design system!', time: '10:05', type: 'text' }]);
  const [inputText, setInputText] = useState('');
  const [projectPrompt, setProjectPrompt] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const chatEndRef = useRef(null);

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
    const raw = new URLSearchParams(window.location.search).get('token');
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
      const identity = await ensureActorIdentity();
      if (alive && identity?.actorId) setActorId(identity.actorId);

      const snapshot = await loadRuntimeSnapshot(identity?.actorId);
      if (!alive) return;

      if (snapshot) {
        if (typeof snapshot.hasOnboarded === 'boolean') setHasOnboarded(snapshot.hasOnboarded);
        if (typeof snapshot.mode === 'string') setMode(snapshot.mode);
        // Don't restore view when an invite token is present in the URL
        const hasInviteParams = new URLSearchParams(window.location.search).has('token')
          || new URLSearchParams(window.location.search).has('invite');
        if (typeof snapshot.view === 'string' && !hasInviteParams) setView(snapshot.view);
        if (typeof snapshot.step === 'number') setStep(snapshot.step);
        if (snapshot.selectedItem) setSelectedItem(snapshot.selectedItem);
        if (snapshot.uiProfile) setUIProfile(snapshot.uiProfile);
        if (snapshot.internalProfile) setInternalProfile(snapshot.internalProfile);
        if (Array.isArray(snapshot.acceptanceProtocol)) setAcceptanceProtocol(snapshot.acceptanceProtocol);
        if (Array.isArray(snapshot.badActorFlags)) setBadActorFlags(snapshot.badActorFlags);
        if (snapshot.byocForm) setByocForm(snapshot.byocForm);
        if (Array.isArray(snapshot.contractHistory)) setContractHistory(snapshot.contractHistory);
        if (Array.isArray(snapshot.activityLog)) setActivityLog(snapshot.activityLog.map(e => ({ ...e, timestamp: new Date(e.timestamp) })));
      }

      setIsRuntimeHydrated(true);
    };

    hydrate();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const contractId = String(selectedItem?.id ?? '');
    if (!contractId || contractId === 'mock') return;

    let cancelled = false;
    const mergeEvents = incoming => {
      setContractEvents(prev => {
        const map = new Map(prev.map(e => [e.id, e]));
        incoming.forEach(e => map.set(e.id, e));
        return Array.from(map.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      });
    };

    const load = async () => {
      const remote = await fetchContractEvents(contractId);
      if (cancelled || remote.length === 0) return;
      mergeEvents(remote);
      const initiated = remote.find(e => e.type === EVENT_TYPES.CONTRACT_INITIATED);
      if (initiated?.dod_hash) setDodHash(prev => prev || initiated.dod_hash);
    };

    load();
    const unsubscribe = subscribeToContractEvents(contractId, ev => {
      if (!ev?.id) return;
      mergeEvents([ev]);

      // Step sync: apply state changes from counterparty events.
      // Skip own events — local state was already updated when we wrote them.
      // Reads actorIdRef (always current), not the actorId closed over when
      // this effect last ran — see actorIdRef's declaration for why.
      if (ev.actor_id === actorIdRef.current) return;

      const STEP_MAP = {
        [EVENT_TYPES.CONTRACT_ACCEPTED]: 2,
        [EVENT_TYPES.PERFORMANCE_ASSERTED]:    3,
        [EVENT_TYPES.PERFORMANCE_ACCEPTED]:     4,
        [EVENT_TYPES.PAYMENT_RELEASED]:  5,
        [EVENT_TYPES.CONTRACT_COMPLETED]: 5,
      };

      const targetStep = STEP_MAP[ev.type];
      if (targetStep) {
        setStep(prev => (prev < targetStep ? targetStep : prev));
        addToast('Contract Updated', 'Your counterparty advanced the contract.', 'info');
      }

      if (ev.type === EVENT_TYPES.CONTRACT_CANCELLED) {
        addToast('Contract Cancelled', 'Your counterparty has cancelled this contract.', 'warning');
        setView('home');
        setSelectedItem(null);
        setStep(1);
        setContractEvents([]);
      }

      if (ev.type === EVENT_TYPES.DISPUTE_OPENED || ev.type === EVENT_TYPES.DISPUTE_RESOLVED) {
        addToast('Dispute Update', `Dispute ${ev.type === EVENT_TYPES.DISPUTE_OPENED ? 'opened' : 'resolved'} by counterparty.`, 'warning');
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedItem?.id]);

  useEffect(() => {
    if (!isRuntimeHydrated) return;

    const timer = setTimeout(() => {
      saveRuntimeSnapshot({
        hasOnboarded,
        mode,
        view,
        step,
        selectedItem,
        uiProfile,
        internalProfile,
        acceptanceProtocol,
        badActorFlags,
        byocForm,
        contractHistory,
        activityLog,
      }, actorId);
    }, 900);

    return () => clearTimeout(timer);
  }, [
    isRuntimeHydrated,
    hasOnboarded,
    mode,
    view,
    step,
    selectedItem,
    uiProfile,
    internalProfile,
    acceptanceProtocol,
    badActorFlags,
    byocForm,
    contractHistory,
    activityLog,
  ]);



  // id uses crypto.randomUUID(), not Date.now() — two toasts fired within the
  // same millisecond used to share an id, so the first one's removal timeout
  // (filter(t => t.id !== id)) removed both, and duplicate React keys showed
  // up in ToastContainer/activity-log lists.
  const addToast = useCallback((title, message, type = 'info') => { const id = crypto.randomUUID(); setToasts(prev => [...prev, { id, title, message, type }]); setActivityLog(prev => [{ id, title, message, type, timestamp: new Date() }, ...prev].slice(0, 50)); setUnreadCount(prev => prev + 1); setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000); }, []);

  const toggleMode = () => {
    if (status !== 'idle') return;
    setStatus('switching');
    setTimeout(() => {
        setMode(prev => { const newMode = prev === 'earner' ? 'hirer' : 'earner'; setView('home'); return newMode; });
        setSelectedItem(null);
        setAiSuggestions(null);
        setProjectPrompt('');
        setStatus('idle');
        addToast('Mode Switched', `Active Interface: ${mode === 'earner' ? 'Client (Hirer)' : 'Professional (Earner)'}`);
    }, 800);
  };

  const handleSelect = (item) => { setSelectedItem(item); setIsProfileOpen(false); setView('scoping'); };
  // Always show the current unified profile for the main user
  const handleViewProfile = (data) => {
    if (data && data.id === USER_PROFILE.id) {
      setProfileData(unifiedProfile);
    } else {
      setProfileData(data);
    }
    setIsProfileOpen(true);
  };
  const handleAIArchitectSubmit = () => {
    setStatus('processing');
    setTimeout(() => {
      const tokens = (projectPrompt.match(/(?:[A-Z][a-zA-Z]+|[a-z]{5,})/g) || [])
        .filter((w, i, a) => a.indexOf(w) === i)
        .slice(0, 4);
      const dod = tokens.length >= 2
        ? tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1) + ' — delivered and approved by both parties')
        : ['Deliverable matches the agreed scope', 'Reviewed and signed off by both parties', 'No unresolved objections at handoff'];
      setAiSuggestions({
        summary: 'Criteria extracted from your description. Review each item before locking terms.',
        dod,
        budget: 'Confirm budget before proceeding.',
        candidates: TALENTS_DATA,
      });
      setStatus('idle');
    }, 1500);
  };
  // BiometricModal removed: go directly to contract view
  //
  // Shared by every "start a contract" entry point (ScopingView's AI-architect
  // flow, direct Hire from the marketplace, and agreeing terms in the
  // negotiation chat) so the DoD hash + CONTRACT_INITIATED audit event are
  // always recorded — previously onHire and the negotiation-chat onAgreement
  // path each had their own inline state-setting that skipped both, leaving
  // contracts started that way with no evidence-trail entry for how they began.
  const beginContract = useCallback(async (item) => {
    setSelectedItem(item);
    setView('contract');
    setStep(1);
    if (!item) return;
    const dodText = item.acceptanceCriteria?.join('\n') ?? item.title ?? '';
    const canonical = buildDodCanonical({
      dodText,
      hirerId: mode === 'hirer' ? 'user' : String(item.id),
      earnerId: mode === 'earner' ? 'user' : String(item.id),
      budgetPoints: String(item.totalPoints ?? 0),
      deadline: item.deadline ?? 'TBD',
    });
    const hash = await sha256(canonical);
    setDodHash(hash);
    const event = await logEvent({
      type: EVENT_TYPES.CONTRACT_INITIATED,
      contractId: String(item.id ?? 'mock-' + Date.now()),
      actorId,
      payload: { title: item.title, budgetPoints: item.totalPoints },
    });
    setContractEvents(prev => [event, ...prev]);
  }, [mode, actorId]);

  const initiateContract = () => {
    addToast('Contract Initiated', 'Contract flow started.');
    return beginContract(selectedItem);
  };

  const handleNextStep = useCallback(() => {
    const now = Date.now();
    // Guard: Prevent double execution within 1.5 seconds
    if (now - lastActionTime.current < 1500) return;

    lastActionTime.current = now;
    setStatus('processing');

    setTimeout(async () => {
      // Logic execution
      if (step === 2) {
        if (mode === 'hirer') setUIProfile(s => ({ ...s, points: (s.points ?? 0) - selectedItem.totalPoints, totalSpent: (s.totalSpent ?? 0) + selectedItem.totalPoints }));
        else setUIProfile(s => ({ ...s, points: (s.points ?? 0) + selectedItem.totalPoints }));
      }

      // Phase 4: log step transition events
      const contractId = String(selectedItem?.id ?? 'mock');
      if (step === 1) {
        const ev = await logEvent({ type: EVENT_TYPES.CONTRACT_ACCEPTED, contractId, actorId, payload: { step: 1 } });
        setContractEvents(prev => [ev, ...prev]);
      } else if (step === 4) {
        const ev = await logEvent({ type: EVENT_TYPES.PERFORMANCE_ACCEPTED, contractId, actorId, payload: { step: 4 } });
        setContractEvents(prev => [ev, ...prev]);
        // Fire acceptance email if hirer email is known (BYOC flow).
        // send-acceptance-email now loads recipient/amount/DoD from the
        // contracts DB row for contract_id itself (closes a hole where the
        // old payload-trusting version let a caller send arbitrary content
        // to an arbitrary address) — it only succeeds for a contract that
        // actually exists in that table with state SETTLED. This local/demo
        // flow's `contractId` is not a real row there yet (this whole flow
        // isn't wired to the DB-backed contracts table — see HANDOFF.md), so
        // this call will 404 until that wiring lands. Left in place rather
        // than removed so it starts working the moment that wiring exists.
        if (isSupabaseEnabled && guestEmail) {
          supabase.functions.invoke('send-acceptance-email', {
            body: { contract_id: contractId },
          }).then(({ error }) => {
            if (error) addToast('Email not sent', 'Acceptance email failed to send.', 'warning');
            else addToast('Confirmation sent', 'DoD acceptance email sent to hirer.', 'success');
          });
        }
        // Trust Passport: record contract completion
        setUIProfile(s => {
          const newCompleted = (s.completedContracts ?? 0) + 1;
          const newLevel = deriveLevel(newCompleted);
          return {
            ...s,
            completedContracts: newCompleted,
            exp: (s.exp ?? 0) + 500,
            trustScore: Math.min(1000, (s.trustScore ?? 0) + 5),
            level: newLevel,
            totalEarned: mode === 'earner' ? (s.totalEarned ?? 0) + (selectedItem?.totalPoints ?? 0) : (s.totalEarned ?? 0),
          };
        });
        triggerLevelUp();
      }

      // Navigation
      // (negotiationMessages and negotiationAgreed state are now at the top level)
      if (step === 5) {
          // Log contract completion before resetting
          const ev = await logEvent({ type: EVENT_TYPES.CONTRACT_COMPLETED, contractId, actorId, payload: {} });
          setContractEvents(prev => [ev, ...prev]);
          setContractHistory(prev => [{
            id: contractId,
            title: selectedItem?.title ?? 'Contract',
            client: selectedItem?.client ?? '—',
            date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
            earned: mode === 'earner' ? (selectedItem?.totalPoints ?? 0) : 0,
            rating: uiProfile.avgRating ?? '—',
          }, ...prev]);
          // Reset everything for next cycle
          setView('home');
          setSelectedItem(null);
          setStep(1);
          setDodHash(null);
          setContractEvents([]);
          setIsUploading(false);
          setUploadProgress(0);
          setStatus('idle');
          return;
      }

      setStep(prev => prev + 1);
      setStatus('idle');
    }, 1200);
  }, [step, mode, selectedItem, status, actorId, guestEmail, dodHash]);

  const handleReject = async () => {
    setStep(2);
    addToast('Re-delivery Requested', 'The hirer has requested a revised submission.', 'warning');
    const contractId = String(selectedItem?.id ?? 'mock');
    const ev = await logEvent({ type: EVENT_TYPES.PERFORMANCE_REJECTED, contractId, actorId, payload: { step: 2 } });
    setContractEvents(prev => [ev, ...prev]);
  };
  const handleOpenDispute = () => { setIsDisputeOpen(true); };
  const handleRehire = React.useCallback(() => {
    // Carry over negotiated DoD (acceptanceProtocol) into the re-hire item
    setSelectedItem(prev => prev
      ? { ...prev, acceptanceCriteria: acceptanceProtocol.length > 0 ? [...acceptanceProtocol] : prev.acceptanceCriteria }
      : prev
    );
    // Reset stale contract state so new contract starts clean
    setDodHash(null);
    setContractEvents([]);
    setIsRehire(true);
    setStep(1);
    setView('scoping');
    addToast('Re-hire Template Ready', 'DoD and amount pre-filled from your last contract.', 'info');
  }, [acceptanceProtocol, addToast]);

  const handleContractCancel = React.useCallback(async ({ reason }) => {
    setContractHistory(prev => [{
      id: 'cancelled-' + Date.now(),
      title: selectedItem?.title ?? 'Contract',
      client: selectedItem?.client ?? '—',
      date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      earned: 0,
      rating: '—',
    }, ...prev]);

    // ContractView's own toast ("cancelled and logged") already claims this
    // is recorded — it previously wasn't. Mirrors the counterparty-initiated
    // cancel path below (CONTRACT_CANCELLED branch of the events subscription).
    const contractId = String(selectedItem?.id ?? 'mock');
    await logEvent({ type: EVENT_TYPES.CONTRACT_CANCELLED, contractId, actorId, payload: { reason } });

    // Leaving this contract's view — same reset the counterparty-initiated
    // cancel path does (events subscription's CONTRACT_CANCELLED branch
    // above), including clearing contractEvents rather than keeping the
    // event just logged: it's already persisted, and a stale local list
    // shouldn't bleed into whatever contract is viewed next.
    setView('home');
    setSelectedItem(null);
    setStep(1);
    setContractEvents([]);
  }, [selectedItem, actorId]);

  const handleDisputeResolve = async ({ winner, arbiter, reason } = {}) => {
    setIsDisputeOpen(false);
    const contractId = String(selectedItem?.id ?? 'mock');
    const isPending = winner === 'pending';
    const currentUserWins = !isPending && winner === mode;

    if (isPending) {
      addToast('Arbitration Submitted', `${arbiter === 'human' ? 'Human arbiter' : 'Peer panel'} assigned — ruling expected within ${arbiter === 'human' ? '24–48h' : '48–72h'}.`, 'info');
    } else if (currentUserWins) {
      addToast('Dispute Won', 'Arbitration ruled in your favor. Proceeding to settlement.', 'success');
      setUIProfile(s => ({ ...s, trustScore: Math.min(1000, (s.trustScore ?? 0) + 5) }));
    } else {
      addToast('Dispute Lost', 'Arbitration ruled against you. Stake partially forfeited.', 'error');
      setUIProfile(s => ({ ...s, trustScore: Math.max(0, (s.trustScore ?? 0) - 10) }));
      setBadActorFlags(prev => [...prev, {
        type: EVENT_TYPES.DISPUTE_LOST,
        label: 'Dispute Lost',
        contractId,
        date: new Date().toISOString(),
      }]);
    }

    const ev = await logEvent({
      type: currentUserWins ? EVENT_TYPES.DISPUTE_WON : EVENT_TYPES.DISPUTE_LOST,
      contractId,
      actorId,
      payload: { winner, arbiter, reason, resolvedAt: new Date().toISOString() },
    });
    setContractEvents(prev => [ev, ...prev]);
    // Advance to blind rating phase — both parties rate each other after any dispute resolution
    setStep(4);
  };

  const handleFileUpload = () => {
      if (isUploading) return;
      setIsUploading(true);
      let progress = 0;
      const interval = setInterval(() => {
          progress += 5;
          setUploadProgress(progress);
          if (progress >= 100) {
              clearInterval(interval);
              setIsUploading(false);
              setUploadProgress(0);
              // Directly call handleNextStep logic here to avoid race conditions with button state.
              // Guards against the same double-fire handleNextStep guards against
              // (lastActionTime.current) — this path used to skip that check
              // entirely: isUploading resets to false above, before this delayed
              // step-advance actually runs, leaving a window where a second
              // upload could be started and its own delayed callback would also
              // log WORK_SUBMITTED and advance step.
              const uploadNow = Date.now();
              if (uploadNow - lastActionTime.current < 1500) return;
              lastActionTime.current = uploadNow;
              setStatus('processing');
              setTimeout(async () => {
                  // Phase 4: log work submitted event
                  const ev = await logEvent({
                    type: EVENT_TYPES.PERFORMANCE_ASSERTED,
                    contractId: String(selectedItem?.id ?? 'mock'),
                    actorId,
                    payload: { step: 3 },
                  });
                  setContractEvents(prev => [ev, ...prev]);
                  setStep(prev => prev + 1);
                  setStatus('idle');
                  addToast('Upload Complete', 'AI Inspection initiated.');
              }, 1200);
          }
      }, 80);
  };
  const handlePaymentSuccess = (paymentIntentId) => {
    setActivePaymentIntentId(paymentIntentId);
    setIsPaymentModalOpen(false);
    addToast('Escrow Secured', 'Payment held. Work can begin.', 'success');
  };

  const handleOnboardingComplete = useCallback(() => {
    localStorage.setItem('tf_onboarded', '1');
    setHasOnboarded(true);
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
    setByocContractId(crypto.randomUUID());
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
  const openContractFromHome = useCallback(async (contract) => {
    setAgreementError(null);
    setAgreement({ contract, events: [], role: performsHere(contract) ? 'performer' : 'receiver',
      // The account that owns the agreement. Only this side can read the raw
      // event rows, and therefore only this side can be offered an export.
      source: 'owner' });
    setView('agreement');
    const rows = await fetchContractEvents(contract.id);
    setAgreement(prev => (prev?.contract?.id === contract.id
      ? { ...prev, events: shapeOwnerEvents(rows, contract) }
      : prev));
  }, [shapeOwnerEvents]);

  /** Open the same agreement as the invited counterparty, with no account. */
  const openAgreementAsGuest = useCallback(async (contractId) => {
    setAgreementError(null);
    setAgreement(null);
    setView('agreement');
    const { evidence, reason } = await fetchGuestEvidence(contractId);
    if (!evidence) {
      setAgreementError(reason === 'no_credential'
        ? 'This browser does not hold a credential for this agreement.'
        : 'The agreement could not be loaded.');
      return;
    }
    setAgreement({
      // A guest has no auth.users row, so RLS gives them nothing from `events`
      // directly — their trail comes shaped from guest-contract-events, with
      // each payload allowlist-filtered. They cannot recompute a hash from
      // that, so their export is the server's verified record rather than the
      // owner's re-verifiable one. The unshaped response is kept because the
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
    const rows = await fetchContractEvents(contract.id);
    // An export with nothing in it would still look like a signed record. If
    // the rows could not be read, say so instead of producing one.
    if (rows.length === 0) throw new Error('no readable events for this contract');
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
  }, [agreement]);

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
  }, [agreement]);

  /**
   * Record a performance statement. The server decides whether this party may
   * make it — the screen only offers the action that belongs to the viewer, and
   * a refusal here means the two disagree, which is worth showing.
   */
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
      const rows = await fetchContractEvents(contract.id);
      setAgreement({ contract: fresh, events: shapeOwnerEvents(rows, fresh), role: agreement.role });
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

  const handleBYOCSubmit = useCallback(() => {
    const item = {
      id: byocContractId || ('byoc-' + Date.now()),
      title: byocForm.description || 'Custom Engagement',
      client: byocForm.name || 'Direct Counterparty',
      totalPoints: parseInt(byocForm.amount, 10) || 0,
      acceptanceCriteria: byocForm.dod
        ? byocForm.dod.split('\n').map(s => s.trim()).filter(Boolean)
        : [],
    };
    setSelectedItem(item);
    setShowBYOCForm(false);
    setByocForm({ name: '', description: '', amount: '', dod: '' });
    setByocContractId('');
    setInviteLink(null);
    setInviteLinkCopied(false);
    setView('scoping');
    addToast('Agreement Started', 'Define your scope below.');
  }, [byocForm, addToast, byocContractId]);

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
      const { error } = await requestEarnerVerification((byocForm.earnerEmail || '').trim());
      if (error) {
        setOtpError(error.message ?? 'Could not send the code.');
        setOtpStage('idle');
        return;
      }
      setOtpStage('code');
    } catch (err) {
      setOtpError(String(err?.message ?? err));
      setOtpStage('idle');
    }
  }, [byocForm, persistContractAndLink]);

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

  const triggerSmartContractUpdate = () => { const userMsg = { id: Date.now(), sender: 'me', text: 'Additional requirements for dark mode have come up. Can we increase the budget?', time: 'Now', type: 'text' }; setMessages(prev => [...prev, userMsg]); setTimeout(() => { const aiProposal = { id: Date.now() + 1, sender: 'ai', type: 'contract_update', data: { title: 'Scope Expansion Detected', changes: ['Add: Dark Mode Variants (+12 Screens)', 'Timeline: +2 Days'], additionalCost: 50000, newTotal: selectedItem ? selectedItem.totalPoints + 50000 : 50000 }, time: 'Now' }; setMessages(prev => [...prev, aiProposal]); }, 1500); };
  const acceptContractUpdate = (updateData) => { if (selectedItem) { setSelectedItem(prev => ({ ...prev, totalPoints: updateData.newTotal, acceptanceCriteria: [...prev.acceptanceCriteria, "Dark Mode Variants Completed"] })); } setScrambleTrigger(prev => prev + 1); setMessages(prev => [...prev, { id: Date.now(), sender: 'system', text: `Contract updated. Budget increased by ${formatNumber(updateData.additionalCost)} PTS.`, time: 'Now', type: 'text' }]); addToast('Smart Contract Updated', 'New budget locked in escrow.', 'success'); };
  const handleSendMessage = () => { if (!inputText.trim()) return; setMessages([...messages, { id: Date.now(), sender: 'me', text: inputText, time: 'Now', type: 'text' }]); setInputText(''); setTimeout(() => { setMessages(prev => [...prev, { id: Date.now()+1, sender: 'ai', text: 'Context updated. Evidence logged.', time: 'Now', type: 'text' }]); }, 1000); };
  useEffect(() => { if (isChatOpen && chatEndRef.current) { chatEndRef.current.scrollIntoView({ behavior: "smooth" }); } }, [messages, isChatOpen]);

  // Marketplace and Command Center are no longer in the primary navigation.
  // They are not deleted, and the palette is where they remain reachable —
  // deliberately, so removing them from the main path does not mean losing the
  // ability to look at them while they are being reconsidered.
  const commands = useMemo(() => [
      { id: 'home', label: 'Go to Contracts', icon: LayoutGrid, action: () => setView('home') },
      { id: 'new-contract', label: 'New contract', icon: UserPlus, action: () => handleBYOCStart() },
      { id: 'wallet', label: 'Open Wallet', icon: Wallet, action: () => setView('wallet') },
      { id: 'marketplace', label: 'Open Marketplace (legacy)', icon: LayoutGrid, action: () => setView('marketplace') },
      { id: 'command-center', label: 'Open Command Center (legacy)', icon: Layers, action: () => setView('command-center') },
      { id: 'profile', label: 'View Trust Passport', icon: User, action: () => handleViewProfile(USER_PROFILE) },
      { id: 'switch', label: `Switch to ${mode === 'earner' ? 'Hirer' : 'Earner'} Mode`, icon: RefreshCw, action: toggleMode },
      { id: 'chat', label: 'Toggle Chat', icon: MessageSquare, action: () => setIsChatOpen(prev => !prev) },
  ], [mode, handleBYOCStart]);

  const activeOperations = useMemo(() => {
    if (!selectedItem || step < 1 || step > 4) return [];
    const PHASES = ['', 'COMMITMENT', 'IN ESCROW', 'INSPECTION', 'RATING'];
    const PROGRESS = [0, 20, 40, 60, 80];
    const NEXT_ACTIONS = ['', 'Lock contract terms', 'Submit deliverables', 'Awaiting hirer review', 'Submit rating'];
    return [{
      id: selectedItem.id,
      phase: PHASES[step] || 'ACTIVE',
      title: selectedItem.title || 'Active Contract',
      client: selectedItem.client || '—',
      progress: PROGRESS[step] || 0,
      nextAction: NEXT_ACTIONS[step] || '—',
    }];
  }, [selectedItem, step]);

  // Strategy level (Conservative / Normal / Aggressive)
  const [strategy, setStrategy] = useState('Balanced');



  // Unified profile object merging static and dynamic user data.
  // useMemo (not useCallback wrapping a call) — the previous version called
  // the useCallback-memoized function on every render regardless of whether
  // its deps changed, so it produced a fresh object reference every render
  // anyway, defeating referential-equality memoization in consumers like
  // CommandCenterView.
  const unifiedProfile = useMemo(() => ({
    ...USER_PROFILE,
    ...uiProfile,
    badActorFlags,
  }), [uiProfile, badActorFlags]);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans selection:bg-indigo-500/30 overflow-x-hidden relative">
      <NeuralBackground />

      {!hasOnboarded && <OnboardingView onComplete={handleOnboardingComplete} />}

      <ToastContainer toasts={toasts} removeToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      <PaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        onSuccess={handlePaymentSuccess}
        contractId={selectedItem ? String(selectedItem.id ?? '') : ''}
        amountJpy={selectedItem?.totalPoints ?? 0}
        projectName={selectedItem?.title ?? 'Contract'}
      />
      {/* BiometricModal removed for MVP slimdown */}
      <DisputeModal isOpen={isDisputeOpen} onClose={() => setIsDisputeOpen(false)} onResolve={handleDisputeResolve} auditData={selectedItem ? { contractId: String(selectedItem.id ?? ''), dodHash, events: contractEvents, meta: { title: selectedItem.title ?? '' } } : null} />
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
      <ProfileModal isOpen={isProfileOpen} onClose={() => setIsProfileOpen(false)} profile={profileData} addToast={addToast} contractHistory={contractHistory} />

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
              <button onClick={() => { setShowBYOCForm(false); setByocContractId(''); setInviteLink(null); setInviteLinkCopied(false); }} className="ml-4 mt-1 text-slate-500 hover:text-white transition-colors shrink-0" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Scrollable body */}
            <div className="overflow-y-auto px-10 py-6 space-y-4 flex-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
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
              </div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Client email</label><input type="email" value={byocForm.clientEmail ?? ''} onChange={e => { setByocForm(f => ({ ...f, clientEmail: e.target.value })); setInviteLink(null); }} placeholder="Where this invite is addressed" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Project name</label><input type="text" value={byocForm.description} onChange={e => { setByocForm(f => ({ ...f, description: e.target.value })); setInviteLink(null); }} placeholder="e.g., Mobile app redesign — 3 screens" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Amount (¥ JPY)</label><input type="number" min="0" value={byocForm.amount} onChange={e => { setByocForm(f => ({ ...f, amount: e.target.value })); setInviteLink(null); }} placeholder="e.g., 300000" className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
                <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Deadline</label><input type="date" value={byocForm.deadline ?? ''} onChange={e => { setByocForm(f => ({ ...f, deadline: e.target.value })); setInviteLink(null); }} className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all" /></div>
              </div>
              <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">What counts as complete <span className="normal-case font-normal text-slate-600">(one item per line)</span></label><textarea value={byocForm.dod} onChange={e => { setByocForm(f => ({ ...f, dod: e.target.value })); setInviteLink(null); }} placeholder={"Definitive Figma Library\nDark Mode Tokens\nAtomic Design Compliance"} className="w-full bg-slate-800 border border-white/10 rounded-2xl px-5 py-4 text-white outline-none focus:border-indigo-500/50 transition-all resize-none min-h-[90px] font-mono text-sm" /></div>
              {otpStage === 'code' && (
                <div className="bg-slate-800/60 border border-indigo-500/30 rounded-2xl px-5 py-4 space-y-3">
                  <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Confirm your email</p>
                  <p className="text-xs text-slate-400">We sent a 6-digit code to {byocForm.earnerEmail}. Entering it links this browser to a permanent account, so your contracts stay reachable.</p>
                  <input type="text" inputMode="numeric" maxLength={6} value={otpCode} onChange={e => setOtpCode(e.target.value)} placeholder="000000" className="w-full bg-slate-900 border border-white/10 rounded-2xl px-5 py-4 text-white text-center text-2xl font-mono tracking-[0.4em] outline-none focus:border-indigo-500/50" />
                  <button onClick={handleVerifyEarnerCode} disabled={otpCode.trim().length < 6} className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-black text-sm transition-all">Confirm &amp; create contract</button>
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
            <div className="px-10 pb-10 pt-4 border-t border-white/5 flex gap-3">
              <button
                onClick={handleSendInvite}
                disabled={
                  otpStage !== 'idle'
                  || !(byocForm.description ?? '').trim()
                  || !(byocForm.earnerName ?? '').trim()
                  || !(byocForm.earnerEmail ?? '').trim()
                  || !(byocForm.clientEmail ?? '').trim()
                }
                className="flex-1 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-black transition-all text-sm"
              >
                {otpStage === 'busy' ? 'Working…' : inviteLink ? 'Create another' : 'Send Invite'}
              </button>
              <button onClick={handleBYOCSubmit} className="flex-1 py-4 rounded-2xl bg-white text-[#020617] font-black hover:bg-indigo-400 hover:text-white transition-all text-sm">Start Myself →</button>
            </div>
          </div>
        </div>
      )}

      {(status === 'processing' || status === 'switching') && (<div className="fixed inset-0 z-[100] bg-[#020617]/90 backdrop-blur-md flex flex-col items-center justify-center"><Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-6" /><p className="text-indigo-400 font-black tracking-[0.5em] text-[10px] uppercase animate-pulse">{status === 'switching' ? 'Reconfiguring Interface...' : 'Verifying Ledger...'}</p></div>)}

      {/* Header */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#020617]/80 backdrop-blur-xl border-b border-white/[0.05] px-6 py-4 flex justify-between items-center transition-all duration-300">
        <div className="flex items-center gap-4 cursor-pointer group" onClick={() => setView('home')}>
          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-lg transition-colors ${mode === 'earner' ? 'bg-indigo-600' : 'bg-emerald-600'}`}>{mode === 'earner' ? <ShieldCheck className="text-white w-6 h-6" /> : <Briefcase className="text-white w-6 h-6" />}</div>
          <div className="hidden sm:block"><span className="font-black text-xl tracking-tighter text-white block leading-none">TRUSTFLOW</span><span className="text-[9px] font-black text-slate-500 tracking-[0.3em] uppercase">{mode === 'earner' ? 'Professional' : 'Client Suite'}</span></div>
        </div>
        <div onClick={() => setIsCommandOpen(true)} className="hidden md:flex flex-1 max-w-md mx-6 items-center gap-3 bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 px-4 py-2.5 rounded-xl cursor-pointer transition-all group"><Search className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" /><span className="text-sm text-slate-500 group-hover:text-slate-300 transition-colors">Type a command...</span><div className="ml-auto flex gap-1"><span className="text-[10px] font-mono text-slate-600 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">⌘K</span></div></div>
        <div className="flex gap-4 items-center">
          {auth.status === 'signed_in' ? (
            <button
              onClick={handleSignOut}
              title={auth.email ? `Signed in as ${auth.email}` : 'Sign out'}
              className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 hover:bg-white/5 transition-all text-xs font-bold text-slate-400 hover:text-white"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          ) : (
            <button
              onClick={() => setView('signin')}
              className="flex items-center gap-2 px-4 py-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all text-xs font-bold text-indigo-300"
            >
              <LogIn className="w-3.5 h-3.5" /> Sign in
            </button>
          )}
          <button onClick={toggleMode} className="flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 hover:bg-white/5 transition-all"><div className={`w-2 h-2 rounded-full ${mode === 'earner' ? 'bg-indigo-500' : 'bg-emerald-500'}`} /><span className="text-xs font-bold uppercase tracking-wider text-slate-300">Switch to {mode === 'earner' ? 'Hire' : 'Work'}</span><RefreshCw className="w-3 h-3 text-slate-500" /></button>
          {/* Wallet button: only enabled if unlocked */}
          <div className={`hidden sm:flex flex-col items-center gap-1 bg-white/[0.03] px-4 py-2 rounded-full border border-white/5 transition-colors ${unlockedFeatures.includes('wallet') ? 'cursor-pointer hover:bg-white/10' : 'opacity-40 cursor-not-allowed'}`}
            onClick={e => {
              if (unlockedFeatures.includes('wallet')) {
                setView('wallet');
              } else {
                e.preventDefault();
                addToast('Locked', 'Wallet unlocks at Level 1.', 'warning');
              }
            }}
            title={unlockedFeatures.includes('wallet') ? 'Open Wallet' : 'Unlock at Level 1'}>
            <div className="flex items-center gap-3">
              <Coins className="w-3.5 h-3.5 text-amber-500" />
              <span className="font-mono font-bold text-xs">{formatNumber(uiProfile.points ?? 0)}</span>
              {!unlockedFeatures.includes('wallet') && (
                <Lock className="w-4 h-4 text-slate-400 ml-2" />
              )}
            </div>
            {!unlockedFeatures.includes('wallet') && (
              <span className="text-[10px] text-slate-400 mt-1">Unlock Wallet at Level 1</span>
            )}
          </div>
          {/* Command Center is no longer in the primary navigation — it was a
              second dashboard competing with the Contracts home. The view still
              exists; ⌘K reaches it. */}
          <button
            className={`hidden sm:inline-flex p-2 ml-1 rounded-full border border-white/10 transition-colors relative ${showActivityLog ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-400 hover:text-indigo-300 hover:bg-white/10'}`}
            title="Activity Log"
            onClick={() => { setShowActivityLog(prev => !prev); setUnreadCount(0); }}
          >
            <Activity className="w-5 h-5" />
            {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-indigo-500 rounded-full text-[9px] font-black text-white flex items-center justify-center leading-none">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
          <div className="flex items-center gap-3 pl-2 border-l border-white/10">
            {/* Chat button: only enabled if unlocked */}
            <div className="flex flex-col items-center">
              <button
                className={`relative p-2 rounded-full transition-colors group ${userLevel >= 2 ? 'hover:bg-white/5' : 'opacity-40 cursor-not-allowed'}`}
                onClick={e => {
                  if (userLevel >= 2) {
                    setIsChatOpen(true);
                  } else {
                    e.preventDefault();
                    addToast('Locked', 'Chat unlocks at Level 2.', 'warning');
                  }
                }}
                title={userLevel >= 2 ? 'Open Chat' : 'Unlock at Level 2'}
              >
                <Bell className="w-5 h-5 text-slate-400 group-hover:text-white transition-colors" />
                {userLevel < 2 && (
                  <span className="absolute -bottom-2 right-1 z-10 flex items-center">
                    <Lock className="w-4 h-4 text-slate-400 drop-shadow" />
                  </span>
                )}
                <span className="absolute top-2 right-2.5 w-1.5 h-1.5 bg-rose-500 rounded-full ring-2 ring-[#020617]" />
              </button>
              {userLevel < 2 && (
                <span className="text-[10px] text-slate-400 mt-1">Unlock Chat at Level 2</span>
              )}
            </div>
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500 to-violet-500 p-[1px] cursor-pointer hover:scale-105 transition-transform hidden sm:block" onClick={() => handleViewProfile(USER_PROFILE)}>
              <div className="w-full h-full rounded-full bg-[#020617] flex items-center justify-center overflow-hidden">
                {USER_PROFILE.avatarUrl ? (
                  <img src={USER_PROFILE.avatarUrl} alt={USER_PROFILE.name} className="w-full h-full object-cover" />
                ) : USER_PROFILE.name ? (
                  <span className="w-full h-full flex items-center justify-center text-base font-bold text-indigo-300">{USER_PROFILE.name[0]}</span>
                ) : (
                  <User className="w-5 h-5 text-slate-300" />
                )}
              </div>
            </div>
          </div>
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
            onAssertDelivery={() => recordAgreementEvent(EVENT_TYPES.PERFORMANCE_ASSERTED)}
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
            onBack={() => { setAgreement(null); setView(auth.status === 'signed_in' ? 'home' : 'invite-accepted'); }}
          />
        )}
        {view === 'signin' && (
          <SignInView
            initialEmail={auth.email ?? ''}
            expired={auth.status === 'expired'}
            onRequestCode={requestSignInCode}
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
            authStatus={auth.status}
            authEmail={auth.email}
            onSignIn={() => setView('signin')}
          />
        )}
        {view === 'marketplace' && <MarketplaceView mode={mode} jobs={JOBS_DATA} talents={TALENTS_DATA} onViewDetails={item => { setProjectDetail(item); setView('project-detail'); }} projectPrompt={projectPrompt} setProjectPrompt={setProjectPrompt} handleAIArchitectSubmit={handleAIArchitectSubmit} aiSuggestions={aiSuggestions} scrambleTrigger={scrambleTrigger} formatNumber={formatNumber} onBYOC={handleBYOCStart} onHire={talent => { addToast('Contract Initiated', 'Contract flow started.'); beginContract(talent); }} />}
        {/* Shared chat state for negotiation stream */}
        {view === 'project-detail' && projectDetail && (
          <ProjectDetailView
            project={projectDetail}
            negotiationHistory={[]}
            onAgreement={() => {
              beginContract(projectDetail); // also sets view='contract', step=1 (Commitment Locked)
              setChatLocked(true); // Lock chat after contract initiation
              addToast('Commitment Locked', 'Contract flow started.');
            }}
            onBack={() => setView('home')}
            onOpenChat={() => setView('negotiation-chat')}
            messages={negotiationMessages}
            agreed={negotiationAgreed}
            setAgreed={setNegotiationAgreed}
            acceptanceProtocol={acceptanceProtocol}
            setAcceptanceProtocol={setAcceptanceProtocol}
            chatLocked={chatLocked}
          />
        )}
        {view === 'negotiation-chat' && (
          <NegotiationChatView
            messages={negotiationMessages}
            setMessages={setNegotiationMessages}
            agreed={negotiationAgreed}
            setAgreed={setNegotiationAgreed}
            acceptanceProtocol={acceptanceProtocol}
            setAcceptanceProtocol={setAcceptanceProtocol}
            chatLocked={chatLocked}
            onBack={(next, evidence) => {
              if (next === 'scoping') {
                // Ensure selectedItem is set from projectDetail if not already
                if (!selectedItem && projectDetail) {
                  setSelectedItem(projectDetail);
                }
                // Optionally, store evidence/messages for later use
                setView('scoping');
              } else {
                setView('project-detail');
              }
            }}
          />
        )}
        {/* ScopingView removed from contract flow. */}
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
              const raw = new URLSearchParams(window.location.search).get('token');
              const name = guestName || 'Guest';
              const { accepted, reason } = await acceptInvite(raw, email, name);
              if (!accepted) {
                setInviteTokenError(reason === 'already_used' ? 'already_used' : reason);
                setInviteData(null);
                return;
              }

              const contractId = accepted.contract_id;
              // The guest Hirer's credential for this contract. Without it the
              // log-event function has no way to tell this browser apart from
              // any other, and the acceptance record below is rejected.
              storeGuestAccessToken(contractId, accepted.guest_access_token);
              setSelectedItem({
                id: contractId,
                title: accepted.project_name,
                client: accepted.earner_display_name ?? 'Your counterparty',
                totalPoints: accepted.amount_jpy ?? 0,
                acceptanceCriteria: accepted.dod ?? [],
                deadline: accepted.deadline ?? null,
              });
              setGuestName(name);
              if (email) setGuestEmail(email);
              window.history.replaceState({}, '', window.location.pathname);
              setView('invite-accepted');
              // No qualification needed any more. The response exists only
              // because the acceptance and its evidence committed together.
              addToast('Agreement accepted', 'Your acceptance has been recorded.', 'success');
            }}
            onDecline={() => {
              window.history.replaceState({}, '', window.location.pathname);
              setView('home');
            }}
          />
        )}
        {view === 'invite-accepted' && (
          <div className="max-w-lg mx-auto text-center space-y-6 py-20 animate-fade-in-up">
            <div className="w-16 h-16 rounded-[20px] bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-3xl font-black tracking-tighter text-white">Agreement accepted</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your acceptance of <span className="text-white font-bold">{selectedItem?.title}</span> has been
              timestamped and recorded. {selectedItem?.client} has been notified.
            </p>
            <p className="text-xs text-slate-500 leading-relaxed border border-white/5 bg-white/[0.02] rounded-2xl px-5 py-4">
              Payment is handled separately for now — {selectedItem?.client} will contact you about it.
              TrustFlow is not collecting money for this agreement yet.
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
            onBack={() => setView('invite-accepted')}
          />
        )}
        {view === 'scoping' && selectedItem && <ScopingView selectedItem={selectedItem} onBack={() => { setIsRehire(false); setView('home'); setSelectedItem(null); }} onInitiate={() => { setIsRehire(false); initiateContract(); }} scrambleTrigger={scrambleTrigger} formatNumber={formatNumber} isRehire={isRehire} />}
        {view === 'contract' && selectedItem && <ContractView step={step} handleNextStep={handleNextStep} handleReject={handleReject} onOpenDispute={handleOpenDispute} isUploading={isUploading} uploadProgress={uploadProgress} handleFileUpload={handleFileUpload} status={status} formatNumber={formatNumber} userStats={uiProfile} setUserStats={setUIProfile} addToast={addToast} triggerLevelUp={triggerLevelUp} triggerParamUp={triggerParamUp} mode={mode} onRehire={handleRehire} contractEvents={contractEvents} dodHash={dodHash} contractId={String(selectedItem?.id ?? 'mock')} contractAmount={selectedItem?.totalPoints ?? 0} onContractCancel={handleContractCancel} onBack={() => { setView('home'); setSelectedItem(null); }} guestName={guestName} />}
              {/* Global Level Up/Param Up Animation */}
              {showLevelUp && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
                  {/* Overlay background */}
                  <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
                  <div className="relative flex flex-col items-center justify-center">
                    <div className="text-5xl font-black text-emerald-400 drop-shadow-[0_4px_32px_rgba(16,185,129,0.7)] animate-pop-scale mb-4 text-center" style={{textShadow:'0 2px 16px #059669, 0 0 2px #fff'}}>LEVEL UP!</div>
                    <div className="text-xl font-bold text-indigo-200 drop-shadow animate-fade-in-up text-center">
                      New ability unlocked: <span className="text-white">Priority Support</span>
                    </div>
                  </div>
                </div>
              )}
              {showParamUp && !showLevelUp && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
                  <div className="text-3xl font-black text-indigo-300 drop-shadow animate-pop-fade">+1 PARAMETER</div>
                </div>
              )}
        {view === 'wallet' && <WalletView onBack={() => setView('home')} trustPointsLedger={trustPointsLedger} trustScore={uiProfile.trustScore ?? 0} contractsCompleted={uiProfile.completedContracts ?? 0} formatNumber={formatNumber} />}
        {view === 'command-center' && (
          <CommandCenterView
            activeOperations={activeOperations}
            missionLogs={contractHistory}
            onOperationClick={op => {
              if (selectedItem && String(op.id) === String(selectedItem.id)) {
                setView('contract');
              } else {
                setSelectedItem(op);
                let stepNum = 1;
                if (op.progress >= 80) stepNum = 4;
                else if (op.progress >= 60) stepNum = 3;
                else if (op.progress >= 40) stepNum = 2;
                setStep(stepNum);
                setView('contract');
              }
            }}
            strategy={strategy}
            onStrategyChange={setStrategy}
            unifiedProfile={unifiedProfile || { level: 1, badges: [], trustScore: 0, avgRating: 0, skillEndorsements: {}, repeatClients: 0, responseSpeed: '', reliability: 0 }}
            onViewProfile={() => {
              setProfileData(unifiedProfile);
              setIsProfileOpen(true);
            }}
            setUIProfile={setUIProfile}
          />
        )}

      </main>

      {/* Floating Chat Overlay */}
      <div className="fixed bottom-24 sm:bottom-6 right-6 z-[60] flex flex-col items-end gap-4">
        {/* Show chat only if unlocked */}
        {isChatOpen && unlockedFeatures.includes('chat') && (
          <div className="w-80 sm:w-96 h-[500px] bg-[#0f172a]/95 backdrop-blur-xl border border-white/10 rounded-[32px] shadow-2xl flex flex-col overflow-hidden animate-fade-in-up">
            <div className="p-6 border-b border-white/5 flex justify-between items-center bg-white/[0.02]"><div className="flex items-center gap-3"><div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center"><BrainCircuit className="w-5 h-5 text-white" /></div><div><p className="font-black text-white text-sm">Context Chat</p><p className="text-[10px] font-emerald-400 font-bold uppercase tracking-widest">Online</p></div></div><button onClick={() => setIsChatOpen(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-400"><X className="w-5 h-5" /></button></div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
                  {msg.type === 'contract_update' ? (
                    <div className="max-w-[90%] w-full bg-indigo-900/40 border border-indigo-500/30 p-5 rounded-[24px] rounded-bl-none"><div className="flex items-center gap-2 mb-3 text-indigo-300"><FileSignature className="w-4 h-4" /><span className="text-[10px] font-black uppercase tracking-widest">Smart Contract Proposal</span></div><h4 className="font-bold text-white mb-2">{msg.data.title}</h4><ul className="space-y-1 mb-4">{msg.data.changes.map((change, i) => (<li key={i} className="text-xs text-slate-300 flex items-center gap-2"><div className="w-1 h-1 bg-emerald-400 rounded-full" /> {change}</li>))}</ul><div className="flex justify-between items-end mb-4 pt-3 border-t border-white/10"><span className="text-[10px] font-bold text-slate-500 uppercase">Cost Impact</span><span className="text-lg font-black text-white">+{formatNumber(msg.data.additionalCost)} PTS</span></div><div className="flex gap-2"><button className="flex-1 py-2 bg-white/10 rounded-xl text-xs font-bold text-slate-400 hover:text-white">Reject</button><button onClick={() => acceptContractUpdate(msg.data)} className="flex-1 py-2 bg-indigo-600 rounded-xl text-xs font-bold text-white hover:bg-indigo-500">Accept Update</button></div></div>
                  ) : (<div className={`max-w-[80%] p-4 rounded-2xl text-xs sm:text-sm font-medium leading-relaxed ${msg.sender === 'me' ? 'bg-indigo-600 text-white rounded-br-none' : msg.sender === 'ai' ? 'bg-indigo-900/30 border border-indigo-500/30 text-indigo-200 rounded-bl-none' : 'bg-white/10 text-slate-200 rounded-bl-none'}`}>{msg.sender === 'ai' && <p className="text-[8px] font-black uppercase tracking-widest text-indigo-400 mb-1">AI System Log</p>}{msg.text}<p className="text-[9px] opacity-50 mt-2 text-right">{msg.time}</p></div>)}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-4 border-t border-white/5 bg-[#020617]/50"><button onClick={triggerSmartContractUpdate} className="text-[10px] text-slate-500 hover:text-indigo-400 mb-2 w-full text-center uppercase tracking-widest font-bold opacity-50 hover:opacity-100 transition-opacity">[Dev: Simulate Scope Creep]</button><div className="flex items-center gap-2 bg-white/5 rounded-full px-4 py-2 border border-white/5"><input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()} placeholder="Type a message..." className="bg-transparent border-none outline-none text-white text-sm flex-1 placeholder:text-slate-500" /><button onClick={handleSendMessage} className="p-2 bg-indigo-600 rounded-full text-white hover:bg-indigo-500"><Send className="w-4 h-4" /></button></div></div>
          </div>
        )}
        <button
          onClick={e => {
            if (userLevel >= 2) {
              setIsChatOpen(!isChatOpen);
            } else {
              e.preventDefault();
              addToast('Locked', 'Chat unlocks at Level 2.', 'warning');
            }
          }}
          className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(79,70,229,0.5)] transition-transform active:scale-95 relative ${userLevel >= 2 ? 'bg-indigo-600 text-white hover:scale-110' : 'bg-slate-700 text-slate-400 opacity-50 cursor-not-allowed'}`}
          title={userLevel >= 2 ? 'Open Chat' : 'Unlock at Level 2'}
        >
          <span className="relative w-full h-full flex items-center justify-center">
            <MessageSquare className={`w-6 h-6 sm:w-7 sm:h-7 ${userLevel < 2 ? 'text-slate-400 opacity-60' : ''}`} />
            {userLevel < 2 && (
              <Lock className="absolute right-0 bottom-0 w-3 h-3 text-slate-400 z-10" />
            )}
          </span>
        </button>
      </div>

      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-[#0F172A]/80 backdrop-blur-2xl border-t border-white/10 px-8 py-5 flex justify-between items-center z-50 shadow-[0_-15px_40px_rgba(0,0,0,0.6)]">
        <button title="Contracts" className={`p-3 transition-all duration-300 ${view === 'home' ? 'text-indigo-400 scale-125 bg-indigo-500/10 rounded-2xl shadow-[0_0_20px_rgba(99,102,241,0.2)]' : 'text-slate-500 hover:text-slate-300'}`} onClick={() => { setIsProfileOpen(false); setIsCommandOpen(false); setProfileData(null); setView('home'); }}><LayoutGrid className="w-6 h-6" /></button>
        <button className={`p-3 transition-all duration-300 ${view === 'wallet' ? 'text-indigo-400 scale-125 bg-indigo-500/10 rounded-2xl shadow-[0_0_20px_rgba(99,102,241,0.2)]' : 'text-slate-500 hover:text-slate-300'}`} onClick={() => { setIsProfileOpen(false); setIsCommandOpen(false); setProfileData(null); setView('wallet'); }}><Wallet className="w-6 h-6" /></button>
        {/* Command Center icon (mobile only) */}

        <button className="p-3 text-slate-500 inline-flex" onClick={() => { setIsCommandOpen(false); setView('home'); setProfileData(unifiedProfile); setIsProfileOpen(true); }}>
          {/* Avatar icon for mobile bottom bar (same as header) */}
          <span className="block w-6 h-6 rounded-full overflow-hidden border-2 border-indigo-400 bg-slate-800">
            {USER_PROFILE.avatarUrl ? (
              <img src={USER_PROFILE.avatarUrl} alt={USER_PROFILE.name} className="w-full h-full object-cover" />
            ) : USER_PROFILE.name ? (
              <span className="w-full h-full flex items-center justify-center text-xs font-bold text-indigo-300">{USER_PROFILE.name[0]}</span>
            ) : (
              <User className="w-4 h-4 text-slate-400" />
            )}
          </span>
        </button>
      </nav>

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