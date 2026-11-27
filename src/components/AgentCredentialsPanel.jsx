// src/components/AgentCredentialsPanel.jsx
//
// Minimal owner-only credential management UI (Schedule Row 6).
// Default-off behind `VITE_OWNER_CREDENTIALS_UI === 'on'` (enforced by parent).
// Allows the deal owner to list, issue (scoped, <= 30d expiry, secret shown
// once), and revoke per-deal `owner_account` agent grants.
//
// SECRET & SESSION HANDLING
// - The issued token `<lowercase-uuid>.<64 hex>` lives only in transient
//   controller state inside a ModalDialog and is wiped on dismiss, revoke,
//   SIGNED_OUT / user-id change (including cross-tab), deal switch, or unmount.
// - Late responses arriving after sign-out, user change, or deal switch are
//   discarded without displaying the secret and without automatic destructive
//   cleanup; any unseen issued grant remains visible and revocable from the
//   agreement's credential list once signed in as the owner.

import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Copy, ShieldOff, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import ModalDialog from './ui/ModalDialog'
import { supabase } from '../lib/supabase.js'
import {
  OWNER_SCOPES,
  EXPIRY_PRESETS,
  MAX_GRANT_DAYS,
  computeExpiryIso,
  grantStatus,
  credentialErrorMessage,
  mountCredentialPanelSession,
} from '../lib/entryCredentials.js'

const SCOPE_LABELS = Object.fromEntries(OWNER_SCOPES.map(s => [s.id, s.label]))

function formatStamp(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function AgentCredentialsPanel({ contract, ownerUserId }) {
  const contractId = contract?.id ?? null
  const ownerRole = contract?.performed_by === 'counterparty' ? 'receiver' : 'performer'

  const [panel, setPanel] = useState(() => ({
    grants: [],
    loading: Boolean(contractId && ownerUserId),
    listError: null,
    issuing: false,
    issueError: null,
    issuanceDisabled: false,
    revealed: null,
    revokingId: null,
    revokeError: null,
  }))
  const [selectedScopes, setSelectedScopes] = useState([])
  const [expiryMode, setExpiryMode] = useState('24h')
  const [customDays, setCustomDays] = useState('7')
  const [validationError, setValidationError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(null)

  const controllerRef = useRef(null)
  const copyTimerRef = useRef(null)

  useEffect(() => {
    if (!contractId || !ownerUserId) return undefined
    const { controller, cleanup } = mountCredentialPanelSession({
      authClient: supabase?.auth,
      contractId,
      ownerUserId,
      onState: (next) => setPanel(next),
      onAuthInvalidated: () => {
        setCopied(false)
        setCopyError(null)
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      },
    })
    controllerRef.current = controller

    return () => {
      cleanup()
      controllerRef.current = null
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [contractId, ownerUserId])

  const toggleScope = (scopeId) => {
    setValidationError(null)
    controllerRef.current?.clearIssueError()
    setSelectedScopes(prev => (
      prev.includes(scopeId) ? prev.filter(s => s !== scopeId) : [...prev, scopeId]
    ))
  }

  const handleIssue = async (e) => {
    e.preventDefault()
    const controller = controllerRef.current
    if (!controller || panel.issuing || panel.issuanceDisabled) return
    setValidationError(null)

    let durationMs
    if (expiryMode === 'custom') {
      const days = Number(customDays)
      if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
        setValidationError(`Choose a whole number of days between 1 and ${MAX_GRANT_DAYS}.`)
        return
      }
      durationMs = days === MAX_GRANT_DAYS
        ? EXPIRY_PRESETS.find(p => p.id === '30d').ms
        : days * 24 * 60 * 60 * 1000
    } else {
      durationMs = EXPIRY_PRESETS.find(p => p.id === expiryMode)?.ms
    }

    const expiry = computeExpiryIso(durationMs)
    if (!expiry.ok) {
      setValidationError(credentialErrorMessage(expiry.reason))
      return
    }

    const res = await controller.issue({
      scopes: selectedScopes,
      expiresAt: expiry.expiresAt,
    })
    if (res.ok) {
      setCopied(false)
      setCopyError(null)
      setSelectedScopes([])
    }
  }

  const handleRevoke = async (grantId) => {
    await controllerRef.current?.revoke(grantId)
  }

  const dismissSecret = useCallback(() => {
    controllerRef.current?.dismissReveal()
    setCopied(false)
    setCopyError(null)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const copyToken = async () => {
    const token = panel.revealed?.token
    if (!token) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError('Could not copy automatically — select and copy the token manually.')
    }
  }

  if (!contractId || !ownerUserId) return null

  const activeReveal = panel.revealed && panel.revealed.contractId === contractId
    ? panel.revealed
    : null
  const displayIssueError = validationError ?? panel.issueError

  return (
    <section
      aria-label="Agent credentials"
      className="rounded-[24px] border border-white/10 bg-[#0f172a]/60 px-6 py-5 space-y-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Agent credentials
          </h2>
          <p className="text-xs text-slate-400">
            Scoped, revocable credentials for your agent on this agreement only (max {MAX_GRANT_DAYS} days).
          </p>
        </div>
        <button
          type="button"
          onClick={() => controllerRef.current?.load()}
          disabled={panel.loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-bold disabled:opacity-40 transition-all"
        >
          <RefreshCw className={`w-3 h-3 ${panel.loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Existing grants list */}
      <div className="space-y-2">
        {panel.listError && (
          <p role="alert" className="flex items-start gap-2 text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {panel.listError}
          </p>
        )}
        {panel.revokeError && (
          <p role="alert" className="flex items-start gap-2 text-xs text-rose-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {panel.revokeError}
          </p>
        )}
        {!panel.loading && !panel.listError && panel.grants.length === 0 && (
          <p className="text-xs text-slate-500">No agent credentials issued for this agreement yet.</p>
        )}
        {panel.grants.length > 0 && (
          <ul className="space-y-2">
            {panel.grants.map((g) => {
              const status = grantStatus(g)
              const badgeClass = status === 'active'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : status === 'revoked'
                  ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  : 'bg-slate-500/10 text-slate-400 border-white/10'
              return (
                <li
                  key={g.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 flex flex-wrap items-start justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-white">{g.id.slice(0, 8)}…</span>
                      <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${badgeClass}`}>
                        {status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300">
                      {(g.scopes ?? []).map(s => SCOPE_LABELS[s] ?? s).join(', ')}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500">
                      Expires {formatStamp(g.expires_at)}
                      {g.revoked_at ? ` · Revoked ${formatStamp(g.revoked_at)}` : ''}
                    </p>
                  </div>
                  {status === 'active' && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(g.id)}
                      disabled={Boolean(panel.revokingId)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 text-xs font-bold disabled:opacity-40 transition-all shrink-0"
                    >
                      {panel.revokingId === g.id
                        ? <><Loader2 className="w-3 h-3 animate-spin" /> Revoking…</>
                        : <><ShieldOff className="w-3 h-3" /> Revoke</>}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Scoped issuance form */}
      <form onSubmit={handleIssue} className="border-t border-white/10 pt-4 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-300">Issue a new owner credential</p>
          {panel.issuanceDisabled && (
            <p role="status" className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-2xl px-4 py-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Agent credential issuance is currently disabled on this server. You can still list and revoke existing credentials above.
            </p>
          )}
          <fieldset disabled={panel.issuing || panel.issuanceDisabled} className="space-y-2 disabled:opacity-50">
            <legend className="text-[11px] text-slate-400">
              Permissions (select explicitly; your role on this agreement is <span className="text-slate-300 font-semibold">{ownerRole}</span>)
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
              {OWNER_SCOPES.map((scope) => {
                const checked = selectedScopes.includes(scope.id)
                const roleNote = scope.roleHint === 'either'
                  ? null
                  : scope.roleHint === ownerRole ? null : `(${scope.roleHint} only)`
                return (
                  <label
                    key={scope.id}
                    className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs cursor-pointer transition-colors ${
                      checked
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-white'
                        : 'border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleScope(scope.id)}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <span className="leading-snug">
                      {scope.label}
                      {roleNote && <span className="text-slate-500 ml-1">{roleNote}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="credential-expiry" className="block text-[11px] text-slate-400">
              Expires in (max {MAX_GRANT_DAYS} days)
            </label>
            <select
              id="credential-expiry"
              value={expiryMode}
              onChange={(e) => { setExpiryMode(e.target.value); setValidationError(null); controllerRef.current?.clearIssueError() }}
              disabled={panel.issuing || panel.issuanceDisabled}
              className="bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-xl px-3 py-2 text-xs text-white outline-none disabled:opacity-50"
            >
              {EXPIRY_PRESETS.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              <option value="custom">Custom (days)</option>
            </select>
          </div>
          {expiryMode === 'custom' && (
            <div className="space-y-1">
              <label htmlFor="credential-custom-days" className="block text-[11px] text-slate-400">
                Days (1–{MAX_GRANT_DAYS})
              </label>
              <input
                id="credential-custom-days"
                type="number"
                min={1}
                max={MAX_GRANT_DAYS}
                step={1}
                value={customDays}
                onChange={(e) => { setCustomDays(e.target.value); setValidationError(null); controllerRef.current?.clearIssueError() }}
                disabled={panel.issuing || panel.issuanceDisabled}
                className="w-24 bg-[#0f172a] border border-white/10 focus:border-indigo-500/50 rounded-xl px-3 py-2 text-xs text-white outline-none disabled:opacity-50"
              />
            </div>
          )}
          <button
            type="submit"
            disabled={panel.issuing || panel.issuanceDisabled || selectedScopes.length === 0}
            className="px-5 py-2 rounded-2xl bg-white text-[#020617] font-black text-xs hover:bg-indigo-400 hover:text-white transition-all disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {panel.issuing ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Issuing…</> : 'Issue credential'}
          </button>
        </div>

        {displayIssueError && !panel.issuanceDisabled && (
          <p role="alert" className="flex items-start gap-2 text-xs text-rose-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {displayIssueError}
          </p>
        )}

        <p className="text-[11px] text-slate-500 leading-relaxed">
          The secret is shown once and never stored by TrustFlow. If you sign out or leave this
          screen before an issued secret is shown, it is discarded rather than auto-revoked — you
          can still find and revoke any unseen grant from the list above. Grant records are
          permanent evidence — once a credential is issued, this agreement cannot be deleted even
          after revocation. Revoking a credential stops new requests after commit; an in-flight
          request already admitted may still finish, and anything already read stays read.
        </p>
      </form>

      {/* One-time secret reveal modal */}
      <ModalDialog
        open={Boolean(activeReveal)}
        onClose={dismissSecret}
        title="Save your agent credential"
        actions={
          <>
            <button
              type="button"
              onClick={copyToken}
              className={`px-5 py-2.5 rounded-2xl font-black text-xs transition-all inline-flex items-center gap-1.5 ${
                copied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
            >
              <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : 'Copy token'}
            </button>
            <button
              type="button"
              onClick={dismissSecret}
              className="px-5 py-2.5 rounded-2xl border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 font-bold text-xs transition-all"
            >
              Done
            </button>
          </>
        }
      >
        {activeReveal && (
          <div className="space-y-3 text-sm">
            <p className="text-amber-300 text-xs font-semibold">
              This credential is shown once — closing this dialog discards it here. Clear your clipboard after pasting.
            </p>
            <div className="rounded-2xl border border-indigo-500/30 bg-slate-950/80 px-4 py-3 space-y-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400">
                x-trustflow-grant token
              </p>
              <p className="font-mono text-xs text-white break-all select-all leading-relaxed">
                {activeReveal.token}
              </p>
            </div>
            {copyError && (
              <p role="alert" className="text-xs text-amber-400">{copyError}</p>
            )}
            <p className="text-xs text-slate-400">
              Grant ID: <span className="font-mono text-slate-300">{activeReveal.grantId}</span>
              <br />
              Scopes: {(activeReveal.scopes ?? []).map(s => SCOPE_LABELS[s] ?? s).join(', ')}
              <br />
              Expires: {formatStamp(activeReveal.expiresAt)}
            </p>
          </div>
        )}
      </ModalDialog>
    </section>
  )
}
