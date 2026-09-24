import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { localISO } from './dbUtils'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import { X, PhoneCall, Plus } from 'lucide-react'
import { LogCallForm } from './CallFollowupPrompt'

const dayLabel = ymd => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}
const whenLabel = iso => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

// Dashboard card: stores whose LATEST call has a follow-up date, grouped by date.
// A newer call without a follow-up clears the store from the list.
export default function FollowupsCard() {
  const [groups, setGroups] = useState([]) // [{ key, label, tone, stores: [{store_id, name, follow_up_on}] }]
  const [openStore, setOpenStore] = useState(null)
  const [showAll, setShowAll] = useState(false)

  async function load() {
    const { data } = await supabase.from('call_logs')
      .select('store_id, follow_up_on, called_at, stores(name, is_active)')
      .not('store_id', 'is', null)
      .order('called_at', { ascending: false }).limit(1000)
    const latest = {}
    ;(data || []).forEach(l => { if (!latest[l.store_id]) latest[l.store_id] = l })
    const today = localISO()
    const byKey = {}
    Object.values(latest).filter(l => l.follow_up_on && l.stores?.is_active !== false).forEach(l => {
      const key = l.follow_up_on < today ? 'overdue' : l.follow_up_on
      if (!byKey[key]) byKey[key] = []
      byKey[key].push({ store_id: l.store_id, name: l.stores?.name || 'Store', follow_up_on: l.follow_up_on })
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
    return () => window.removeEventListener('prosa:call_logged', load)
  }, [])

  const total = groups.reduce((n, g) => n + g.stores.length, 0)
  const dueNow = groups.filter(g => g.key === 'overdue' || g.label === 'Today').reduce((n, g) => n + g.stores.length, 0)
  const visible = showAll ? groups : groups.slice(0, 4)

  return (
    <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[var(--text-muted)] text-xs flex items-center gap-1.5"><PhoneCall size={12} /> Follow-ups</span>
        <span className="text-[var(--text-muted2)] text-xs">
          {total === 0 ? 'none' : `${total} store${total !== 1 ? 's' : ''}`}
          {dueNow > 0 && <span className="text-[var(--text-gold)] font-medium"> · {dueNow} due</span>}
        </span>
      </div>
      {total === 0 && <p className="text-[var(--text-muted2)] text-sm">No follow-ups scheduled. Log a call to add one.</p>}
      <div className="flex flex-col gap-2.5">
        {visible.map(g => (
          <div key={g.key}>
            <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${g.tone}`}>{g.label}</div>
            <div className="flex flex-col">
              {g.stores.map(s => (
                <button key={s.store_id} onClick={() => setOpenStore(s)}
                  className="text-left text-sm text-[var(--text-primary)] py-1.5 border-t border-[var(--bg-input)]/30 first:border-0 flex justify-between gap-2 hover:text-[var(--accent)]">
                  <span className="truncate">{s.name}</span>
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
    </div>
  )
}

// Full call history for one store, newest first
export function CallLogModal({ store, onClose }) {
  const [logs, setLogs] = useState(null)
  const [adding, setAdding] = useState(false)
  const phones = useStoreContacts()
  async function load() {
    const { data } = await supabase.from('call_logs')
      .select('id, note, follow_up_on, called_at')
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
            <ContactButtons phone={phones[store.store_id]} size={15} storeId={store.store_id} storeName={store.name} />
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] ml-1"><X size={20} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {adding ? (
            <div className="bg-[var(--bg-input)]/30 rounded-xl p-3">
              <div className="text-[var(--text-primary)] text-sm font-medium mb-2">Log a call</div>
              <LogCallForm storeId={store.store_id} showDate cancelLabel="Cancel"
                onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
            </div>
          ) : (
            <button onClick={() => setAdding(true)}
              className="self-start text-sm font-medium text-[var(--accent)] flex items-center gap-1">
              <Plus size={14} /> Log a call
            </button>
          )}
          {logs === null && <p className="text-[var(--text-muted2)] text-sm">Loading...</p>}
          {logs?.length === 0 && <p className="text-[var(--text-muted2)] text-sm">No calls logged yet.</p>}
          {logs?.map((l, i) => (
            <div key={l.id} className={`pl-3 border-l-2 ${i === 0 ? 'border-[var(--accent)]' : 'border-[var(--bg-input)]'}`}>
              <div className="text-[var(--text-muted)] text-xs">{whenLabel(l.called_at)}</div>
              {l.note && <div className="text-[var(--text-primary)] text-sm mt-0.5 whitespace-pre-wrap">{l.note}</div>}
              {l.follow_up_on && (
                <div className={`text-xs mt-0.5 ${i === 0 && l.follow_up_on <= localISO() ? 'text-[var(--text-gold)] font-medium' : 'text-[var(--text-muted2)]'}`}>
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
