import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { localISO } from './dbUtils'
import { Phone, X } from 'lucide-react'

const KEY = 'prosa_pending_call'

// Called by the Call button just before handing off to the phone dialer.
export function markCallStarted(store) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...store, at: Date.now() })) } catch { /* ignore */ }
}

const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return localISO(d) }
const QUICK = [['Tomorrow', 1], ['3 days', 3], ['1 week', 7], ['2 weeks', 14]]

// Remark + follow-up form. Used by the after-call prompt and by "Log a call" in the call log.
// showDate: let the user set when the call happened (for calls made outside the app).
export function LogCallForm({ storeId, calledAt, showDate = false, onDone, onCancel, cancelLabel = 'Skip' }) {
  const [note, setNote] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [callDate, setCallDate] = useState(localISO())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true); setError('')
    // Manual entry for today keeps the current time; a past date is stored at noon that day
    let when = calledAt ? new Date(calledAt) : new Date()
    if (showDate && callDate !== localISO()) {
      const [y, m, d] = callDate.split('-').map(Number); when = new Date(y, m - 1, d, 12, 0)
    }
    const { error: e } = await supabase.from('call_logs').insert({
      store_id: storeId,
      note: note.trim() || null,
      follow_up_on: followUp || null,
      called_at: when.toISOString(),
    })
    setSaving(false)
    if (e) { setError('Could not save: ' + e.message); return }
    window.dispatchEvent(new CustomEvent('prosa:call_logged', { detail: { storeId } }))
    onDone?.()
  }

  return (
    <div>
      {showDate && (
        <>
          <label className="text-[var(--text-muted)] text-xs mb-1 block">Called on</label>
          <input type="date" value={callDate} max={localISO()} onChange={e => setCallDate(e.target.value)}
            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />
        </>
      )}
      <label className="text-[var(--text-muted)] text-xs mb-1 block">Remark</label>
      <textarea rows={3} autoFocus value={note} onChange={e => setNote(e.target.value)}
        placeholder="e.g. Manager asked to call back after Onam, interested in batter"
        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3 resize-none" />

      <label className="text-[var(--text-muted)] text-xs mb-1 block">Follow up on</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {QUICK.map(([label, n]) => {
          const v = addDays(n)
          return (
            <button key={label} onClick={() => setFollowUp(f => f === v ? '' : v)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${followUp === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-input)] text-[var(--text-muted)]'}`}>
              {label}
            </button>
          )
        })}
      </div>
      <input type="date" value={followUp} min={localISO()} onChange={e => setFollowUp(e.target.value)}
        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={onCancel} className="px-4 text-[var(--text-muted2)] text-sm">{cancelLabel}</button>
        <button onClick={save} disabled={saving || (!note.trim() && !followUp)}
          className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5">
          {saving ? 'Saving...' : 'Log call'}
        </button>
      </div>
    </div>
  )
}

// Mounted once in the app shell. When the app comes back into view after a call,
// asks how it went and logs remark + follow-up date to call_logs.
export default function CallFollowupPrompt() {
  const [call, setCall] = useState(null)

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      let pending = null
      try { pending = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* ignore */ }
      if (!pending) return
      // Ignore stale entries (> 6 hours) and wait a few seconds so the dialer actually opened
      const age = Date.now() - pending.at
      if (age > 6 * 3600 * 1000) { localStorage.removeItem(KEY); return }
      if (age < 3000) return
      setCall(c => c || pending)
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [])

  function close() {
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
    setCall(null)
  }

  if (!call) return null
  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[var(--bg-card)] rounded-2xl p-4 w-full max-w-md shadow-2xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[var(--text-primary)] font-semibold flex items-center gap-2"><Phone size={15} className="text-[var(--accent)]" /> How did the call go?</div>
            <div className="text-[var(--text-muted2)] text-xs mt-0.5">{call.name}</div>
          </div>
          <button onClick={close} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>
        <LogCallForm storeId={call.storeId} calledAt={call.at} onDone={close} onCancel={close} />
      </div>
    </div>,
    document.body
  )
}
