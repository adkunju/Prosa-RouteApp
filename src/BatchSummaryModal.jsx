import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { reasonLabel, notifyStockChanged } from './stockUtils'
import { X, PackageMinus } from 'lucide-react'

const fmt = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }

// Where one production batch went: stores + qty (with returns that came back from them),
// then stock adjustments with reasons.
export default function BatchSummaryModal({ batch, onClose, onChanged }) {
  const [rows, setRows] = useState(null)
  const [adjs, setAdjs] = useState([])
  const [undoing, setUndoing] = useState(null)

  async function load() {
    const [{ data: lines }, { data: adj }] = await Promise.all([
      supabase.from('delivery_lines').select('id, delivered_on, qty_delivered, stores(name), returns(qty_returned)')
        .eq('batch_id', batch.id).order('delivered_on').order('created_at'),
      supabase.from('stock_adjustments').select('id, qty, reason, notes, adjusted_on').eq('batch_id', batch.id).order('adjusted_on'),
    ])
    setRows((lines || []).map(l => ({
      id: l.id, date: l.delivered_on, store: l.stores?.name || 'Store', sent: l.qty_delivered,
      back: (l.returns || []).reduce((n, r) => n + (r.qty_returned || 0), 0),
    })))
    setAdjs(adj || [])
  }
  useEffect(() => { load() }, [batch.id])

  async function undo(id) {
    setUndoing(id)
    await supabase.from('stock_adjustments').delete().eq('id', id)
    notifyStockChanged()
    await load(); onChanged?.()
    setUndoing(null)
  }

  const sent = (rows || []).reduce((n, r) => n + r.sent, 0)
  const back = (rows || []).reduce((n, r) => n + r.back, 0)
  const adjusted = adjs.reduce((n, a) => n + a.qty, 0)
  const left = batch.qty - sent - adjusted

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/50 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[var(--text-primary)] font-semibold truncate">{batch.skus?.name}</div>
            <div className="text-[var(--text-muted2)] text-xs">Made {fmt(batch.produced_on)} · expires {fmt(batch.expires_on)}</div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>

        <div className="grid grid-cols-4 gap-2 px-4 pt-3">
          {[['Made', batch.qty, 'text-[var(--text-primary)]'], ['Sent', sent, 'text-[var(--text-primary)]'],
            ['Adjusted', adjusted, adjusted ? 'text-[var(--text-amber)]' : 'text-[var(--text-muted2)]'],
            ['Left', left, left < 0 ? 'text-red-400' : 'text-[var(--accent)]']].map(([l, v, c]) => (
            <div key={l} className="bg-[var(--bg-input)]/40 rounded-lg px-2 py-1.5 text-center">
              <div className="text-[var(--text-muted2)] text-[10px] uppercase tracking-wide">{l}</div>
              <div className={`text-sm font-semibold ${c}`}>{v}</div>
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between text-[var(--text-muted)] text-xs mb-1.5">
            <span>Delivered to</span>
            {back > 0 && <span className="text-[var(--text-amber)]">↩ {back} came back</span>}
          </div>
          {rows === null && <p className="text-[var(--text-muted2)] text-sm">Loading...</p>}
          {rows?.length === 0 && <p className="text-[var(--text-muted2)] text-sm">Not delivered yet.</p>}
          {rows?.map(r => (
            <div key={r.id} className="flex items-center gap-2 py-1.5 border-t border-[var(--bg-input)]/30 first:border-0 text-sm">
              <span className="w-12 shrink-0 text-[var(--text-muted2)] text-xs">{fmt(r.date)}</span>
              <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{r.store}</span>
              <span className="shrink-0 text-[var(--text-primary)] font-medium">{r.sent}</span>
              <span className="w-10 shrink-0 text-right text-[var(--text-amber)] text-xs">{r.back ? `↩ ${r.back}` : ''}</span>
            </div>
          ))}

          {adjs.length > 0 && (
            <>
              <div className="text-[var(--text-muted)] text-xs mt-4 mb-1.5">Adjustments</div>
              {adjs.map(a => (
                <div key={a.id} className="flex items-start gap-2 py-1.5 border-t border-[var(--bg-input)]/30 first:border-0 text-sm">
                  <span className="w-12 shrink-0 text-[var(--text-muted2)] text-xs pt-0.5">{fmt(a.adjusted_on)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-[var(--text-amber)] flex items-center gap-1"><PackageMinus size={13} /> {reasonLabel(a.reason)}</span>
                    {a.notes && <span className="block text-[var(--text-muted2)] text-xs">{a.notes}</span>}
                  </span>
                  <span className="shrink-0 text-[var(--text-amber)] font-medium">−{a.qty}</span>
                  <button onClick={() => undo(a.id)} disabled={undoing === a.id} className="w-10 shrink-0 text-right text-[var(--text-muted2)] hover:text-red-400 text-xs">
                    {undoing === a.id ? '...' : 'Undo'}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
