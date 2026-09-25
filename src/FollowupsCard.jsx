import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { localISO } from './dbUtils'
import { fuzzyMatch } from './fuzzy'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import { X, PhoneCall, Plus, Search } from 'lucide-react'
import { LogCallForm, remarkWords, MIN_REMARK_WORDS } from './CallFollowupPrompt'
import { contactLabel } from './contactUtils'

const dayLabel = ymd => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}
const whenLabel = iso => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

// Dashboard card: stores whose LATEST call has a follow-up date, grouped by date.
// Open follow-ups: any call or reminder with a follow-up date, until a NEWER call to
// that store is logged (the newest call's own follow-up stays open). Visit notes and
// reminders never clear anything. A store can have several open items.
export function openFollowups(logs) {
  const lastCall = {}
  logs.forEach(l => {
    if ((l.kind || 'call') === 'call' && (!lastCall[l.store_id] || l.called_at > lastCall[l.store_id])) lastCall[l.store_id] = l.called_at
  })
  return logs.filter(l => l.follow_up_on && (l.kind || 'call') !== 'visit' &&
    (!lastCall[l.store_id] || l.called_at >= lastCall[l.store_id]))
}

export default function FollowupsCard() {
  const [groups, setGroups] = useState([]) // [{ key, label, tone, stores: [{id, store_id, name, follow_up_on, kind, note}] }]
  const [openStore, setOpenStore] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [picking, setPicking] = useState(false)
  const [logFor, setLogFor] = useState(null) // store chosen from the picker → log form opens directly

  async function load() {
    const { data } = await supabase.from('call_logs')
      .select('id, store_id, kind, note, follow_up_on, called_at, stores(name, is_active, pipeline_status)')
      .not('store_id', 'is', null)
      .order('called_at', { ascending: false }).limit(2000)
    const today = localISO()
    const byKey = {}
    openFollowups(data || []).filter(l => l.stores?.is_active !== false && l.stores?.pipeline_status !== 'dropped').forEach(l => {
      const key = l.follow_up_on < today ? 'overdue' : l.follow_up_on
      if (!byKey[key]) byKey[key] = []
      byKey[key].push({ id: l.id, store_id: l.store_id, name: l.stores?.name || 'Store', follow_up_on: l.follow_up_on, kind: l.kind, note: l.note })
    })
    const keys = Object.keys(byKey).sort((a, b) => a === 'overdue' ? -1 : b === 'overdue' ? 1 : a.localeCompare(b))
    setGroups(keys.map(k => ({
      key: k,
      label: k === 'overdue' ? 'Overdue' : k === today ? 'Today' : dayLabel(k),
      tone: k === 'overdue' ? 'text-red-400' : k === today ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted)]',
      stores: byKey[k].sort((a, b) => a.follow_up_on.localeCompare(b.follow_up_on) || a.name.localeCompare(b.name)),
    })))
  }

  useEffect(() => {
    load()
    window.addEventListener('prosa:call_logged', load)
    window.addEventListener('prosa:pipeline_changed', load)
    return () => { window.removeEventListener('prosa:call_logged', load); window.removeEventListener('prosa:pipeline_changed', load) }
  }, [])

  const total = groups.reduce((n, g) => n + g.stores.length, 0) // open items
  const dueNow = groups.filter(g => g.key === 'overdue' || g.label === 'Today').reduce((n, g) => n + g.stores.length, 0)
  const visible = showAll ? groups : groups.slice(0, 4)

  return (
    <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[var(--text-muted)] text-xs flex items-center gap-1.5"><PhoneCall size={12} /> Follow-ups</span>
        <span className="flex items-center gap-2">
          <span className="text-[var(--text-muted2)] text-xs">
            {total === 0 ? 'none' : `${total} open`}
            {dueNow > 0 && <span className="text-[var(--text-gold)] font-medium"> · {dueNow} due</span>}
          </span>
          <button onClick={() => setPicking(true)}
            className="h-7 px-2.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] text-xs font-medium flex items-center gap-1">
            <Plus size={13} /> Log call
          </button>
        </span>
      </div>
      {total === 0 && <p className="text-[var(--text-muted2)] text-sm">No follow-ups scheduled. Log a call to add one.</p>}
      <div className="flex flex-col gap-2.5">
        {visible.map(g => (
          <div key={g.key}>
            <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${g.tone}`}>{g.label}</div>
            <div className="flex flex-col">
              {g.stores.map(s => (
                <button key={s.id} onClick={() => setOpenStore(s)}
                  className="text-left py-1.5 border-t border-[var(--bg-input)]/30 first:border-0 flex justify-between gap-2 group">
                  <span className="min-w-0">
                    <span className="block text-sm text-[var(--text-primary)] truncate group-hover:text-[var(--accent)]">
                      {s.kind === 'reminder' ? '📌 ' : ''}{s.name}
                    </span>
                    {s.note && <span className="block text-[11px] text-[var(--text-muted2)] truncate">{s.note}</span>}
                  </span>
                  {g.key === 'overdue' && <span className="text-red-400 text-xs shrink-0">{dayLabel(s.follow_up_on)}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {groups.length > 4 && (
        <button onClick={() => setShowAll(v => !v)} className="mt-2 text-xs text-[var(--accent)]">
          {showAll ? 'Show less' : `Show all ${groups.length} dates`}
        </button>
      )}
      {openStore && <CallLogModal store={openStore} onClose={() => setOpenStore(null)} />}
      {picking && <StorePicker onClose={() => setPicking(false)} onPick={st => { setPicking(false); setLogFor(st) }} />}
      {logFor && <CallLogModal store={logFor} startAdding onClose={() => setLogFor(null)} />}
    </div>
  )
}

// Full call history for one store, newest first
export function CallLogModal({ store, onClose, startAdding = false }) {
  const [logs, setLogs] = useState(null)
  const [adding, setAdding] = useState(startAdding)
  const [editing, setEditing] = useState(null) // log id being edited
  const [status, setStatus] = useState(store.pipeline_status)
  useEffect(() => { if (!status) supabase.from('stores').select('pipeline_status').eq('id', store.store_id).maybeSingle().then(({ data }) => setStatus(data?.pipeline_status)) }, [store.store_id])
  const phones = useStoreContacts()
  async function load() {
    const { data } = await supabase.from('call_logs')
      .select('id, kind, note, follow_up_on, called_at, store_contacts(salutation, name, title)')
      .eq('store_id', store.store_id)
      .order('called_at', { ascending: false })
    setLogs(data || [])
  }
  useEffect(() => {
    load()
    window.addEventListener('prosa:call_logged', load)
    return () => window.removeEventListener('prosa:call_logged', load)
  }, [store.store_id])

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/50 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[var(--text-primary)] font-semibold truncate">{store.name}</div>
            <div className="text-[var(--text-muted2)] text-xs">Call log</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <ContactButtons phone={phones[store.store_id]} size={15} storeId={store.store_id} storeName={store.name} status={status} />
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] ml-1"><X size={20} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {adding ? (
            <div className="bg-[var(--bg-input)]/30 rounded-xl p-3">
              <div className="text-[var(--text-primary)] text-sm font-medium mb-2">Log a call</div>
              <LogCallForm storeId={store.store_id} showDate cancelLabel="Cancel"
                onDone={() => (startAdding ? onClose() : setAdding(false))}
                onCancel={() => (startAdding ? onClose() : setAdding(false))} />
            </div>
          ) : (
            <button onClick={() => setAdding(true)}
              className="self-start text-sm font-medium text-[var(--accent)] flex items-center gap-1">
              <Plus size={14} /> Log a call
            </button>
          )}
          {logs === null && <p className="text-[var(--text-muted2)] text-sm">Loading...</p>}
          {logs?.length === 0 && <p className="text-[var(--text-muted2)] text-sm">No calls logged yet.</p>}
          {logs?.map((l, i) => editing === l.id ? (
            <EditLogEntry key={l.id} log={l} onDone={() => { setEditing(null); load(); window.dispatchEvent(new CustomEvent('prosa:call_logged', { detail: { storeId: store.store_id } })) }}
              onCancel={() => setEditing(null)} />
          ) : (
            <div key={l.id} className={`pl-3 border-l-2 ${i === 0 ? 'border-[var(--accent)]' : 'border-[var(--bg-input)]'}`}>
              <div className="text-[var(--text-muted)] text-xs flex items-center justify-between gap-2">
                <span>{l.kind === 'reminder' ? '📌 Reminder set' : l.kind === 'visit' ? '🚚 Visit note' : '📞 Call'}{(l.kind || 'call') === 'call' && l.store_contacts?.name ? ` with ${contactLabel(l.store_contacts)}` : ''} · {whenLabel(l.called_at)}</span>
                <button onClick={() => setEditing(l.id)} className="text-[var(--accent)] text-xs font-medium shrink-0">Edit</button>
              </div>
              {l.note && <div className="text-[var(--text-primary)] text-sm mt-0.5 whitespace-pre-wrap">{l.note}</div>}
              {l.follow_up_on && (
                <div className={`text-xs mt-0.5 ${l.follow_up_on <= localISO() ? 'text-[var(--text-gold)] font-medium' : 'text-[var(--text-muted2)]'}`}>
                  Follow up {dayLabel(l.follow_up_on)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

// Searchable list of active stores (prospects first) to pick who you called
function StorePicker({ onClose, onPick }) {
  const [stores, setStores] = useState([])
  const [q, setQ] = useState('')
  useEffect(() => { (async () => {
    const { data } = await supabase.from('stores').select('id, name, pipeline_status')
      .eq('is_active', true).eq('is_depot', false).order('name')
    setStores(data || [])
  })() }, [])
  const rank = s => (s.pipeline_status === 'onboard' ? 1 : s.pipeline_status === 'dropped' ? 2 : 0)
  const list = stores.filter(s => fuzzyMatch(q, s.name)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/50 flex items-center justify-between">
          <span className="text-[var(--text-primary)] font-semibold">Which store did you call?</span>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>
        <div className="p-3 relative">
          <Search size={14} className="absolute left-6 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search store..."
            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {list.map(s => (
            <button key={s.id} onClick={() => onPick({ store_id: s.id, name: s.name })}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[var(--bg-input)] flex items-center justify-between gap-2">
              <span className="text-sm text-[var(--text-primary)] truncate">{s.name}</span>
              {s.pipeline_status && s.pipeline_status !== 'onboard' && (
                <span className="text-[10px] text-[var(--text-muted2)] shrink-0">{s.pipeline_status}</span>
              )}
            </button>
          ))}
          {stores.length > 0 && list.length === 0 && <p className="text-[var(--text-muted2)] text-sm text-center py-6">No store matches</p>}
        </div>
      </div>
    </div>,
    document.body
  )
}

// Inline editor for one call log entry: date, remark, follow-up (clear = done), or delete
function EditLogEntry({ log, onDone, onCancel }) {
  const [date, setDate] = useState(localISO(new Date(log.called_at)))
  const [note, setNote] = useState(log.note || '')
  const [followUp, setFollowUp] = useState(log.follow_up_on || '')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState('')

  // Calls need a real remark (the automatic "Status: a → b" line doesn't count)
  const isCall = (log.kind || 'call') === 'call'
  const remarkOk = !isCall || remarkWords(note.split('\n').filter(x => !x.startsWith('Status:')).join(' ')) >= MIN_REMARK_WORDS
  async function save() {
    if (!remarkOk) return setError('Add a remark — at least 2 words on how the call went')
    setBusy(true); setError('')
    // Keep the original time of day unless the date changed
    const orig = new Date(log.called_at)
    let when = orig
    if (date !== localISO(orig)) { const [y, m, d] = date.split('-').map(Number); when = new Date(y, m - 1, d, 12, 0) }
    const { error: e } = await supabase.from('call_logs').update({
      note: note.trim() || null, follow_up_on: followUp || null, called_at: when.toISOString(),
    }).eq('id', log.id)
    setBusy(false)
    if (e) return setError('Could not save: ' + e.message)
    onDone()
  }
  async function remove() {
    if (!confirmDel) { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); return }
    setBusy(true)
    const { error: e } = await supabase.from('call_logs').delete().eq('id', log.id)
    setBusy(false)
    if (e) return setError('Could not delete: ' + e.message)
    onDone()
  }
  const field = 'w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]'
  return (
    <div className="bg-[var(--bg-input)]/30 rounded-xl p-3 flex flex-col gap-2">
      <label className="text-[var(--text-muted)] text-xs">Date</label>
      <input type="date" value={date} max={localISO()} onChange={e => setDate(e.target.value)} className={field} />
      <label className="text-[var(--text-muted)] text-xs">Remark</label>
      <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} className={field + ' resize-none'} />
      <label className="text-[var(--text-muted)] text-xs flex items-center justify-between">
        <span>Follow up on</span>
        {followUp && <button onClick={() => setFollowUp('')} className="text-[var(--accent)] text-xs font-medium">✓ Mark done (clear)</button>}
      </label>
      <input type="date" value={followUp} onChange={e => setFollowUp(e.target.value)} className={field} />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex items-center gap-2 mt-1">
        <button onClick={remove} disabled={busy} className={`text-xs px-2 ${confirmDel ? 'text-red-400 font-medium' : 'text-[var(--text-muted2)]'}`}>
          {confirmDel ? 'Tap to delete' : 'Delete'}
        </button>
        <button onClick={onCancel} className="ml-auto text-sm text-[var(--text-muted2)] px-3">Cancel</button>
        <button onClick={save} disabled={busy || !remarkOk} className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white text-sm font-semibold rounded-lg px-4 py-2">
          {busy ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
