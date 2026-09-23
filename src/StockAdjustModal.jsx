import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { X, Minus, Plus } from 'lucide-react'
import { ADJUST_REASONS, fetchBatchUsage, notifyStockChanged } from './stockUtils'

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

// batch: optional preselected batch { id, sku_id }. If omitted, user picks from active batches.
export default function StockAdjustModal({ batch, onClose, onSaved }) {
  const [batches, setBatches] = useState([])
  const [batchId, setBatchId] = useState(batch?.id || '')
  const [qty, setQty] = useState(1)
  const [reason, setReason] = useState('self_consumed')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState(localDate())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { (async () => {
    const [{ data: b }, { used }] = await Promise.all([
      supabase.from('production_batches').select('id, sku_id, qty, produced_on, expires_on, is_spare, skus(name)')
        .gte('expires_on', localDate()).order('produced_on'),
      fetchBatchUsage(),
    ])
    const list = (b || []).map(x => ({ ...x, available: x.qty - (used[x.id] || 0) })).filter(x => x.available > 0 || x.id === batch?.id)
    setBatches(list)
    if (!batch?.id && list[0]) setBatchId(list[0].id)
  })() }, [batch?.id])

  const sel = batches.find(b => b.id === batchId)
  const max = sel ? Math.max(0, sel.available) : 0

  async function save() {
    setError('')
    if (!sel) return setError('Pick a batch')
    const n = Number(qty)
    if (!n || n < 1) return setError('Enter a quantity')
    if (n > max) return setError(`Only ${max} pcs left in this batch`)
    if (reason === 'other' && !notes.trim()) return setError('Add a note for "Other"')
    setSaving(true)
    const { error: e } = await supabase.from('stock_adjustments').insert({
      batch_id: sel.id, sku_id: sel.sku_id, qty: n, reason, notes: notes.trim() || null, adjusted_on: date,
    })
    setSaving(false)
    if (e) return setError(e.message)
    notifyStockChanged()
    onSaved?.()
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl p-4 w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[var(--text-primary)] font-semibold">Adjust stock</h3>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>

        <label className="text-[var(--text-muted)] text-xs mb-1 block">Batch</label>
        <div className="flex flex-col gap-1.5 mb-3">
          {batches.length === 0 && <p className="text-[var(--text-muted2)] text-sm">No stock to adjust</p>}
          {batches.map(b => (
            <button key={b.id} onClick={() => { setBatchId(b.id); setQty(q => Math.min(Number(q) || 1, Math.max(1, b.available))) }}
              className={`w-full text-left px-3 py-2 rounded-xl text-sm border transition-colors ${batchId === b.id ? 'bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--text-primary)]' : 'bg-[var(--bg-input)] border-transparent text-[var(--text-secondary)]'}`}>
              <div className="font-medium">{b.skus?.name}{b.is_spare && <span className="text-[var(--text-gold)] text-xs ml-1">(spare)</span>}</div>
              <div className="text-xs text-[var(--text-muted2)]">Made {b.produced_on} · {b.available} pcs left</div>
            </button>
          ))}
        </div>

        <label className="text-[var(--text-muted)] text-xs mb-1 block">Reason</label>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {ADJUST_REASONS.map(r => (
            <button key={r.key} onClick={() => setReason(r.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${reason === r.key ? 'bg-[var(--text-amber)] text-white' : 'bg-[var(--bg-input)] text-[var(--text-muted)]'}`}>
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <label className="text-[var(--text-muted)] text-xs mb-1 block">Quantity (pcs)</label>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(q => Math.max(1, (Number(q) || 1) - 1))} className="w-9 h-9 rounded-lg bg-[var(--bg-input)] text-[var(--text-primary)] flex items-center justify-center"><Minus size={14} /></button>
              <input type="number" min="1" max={max} value={qty} onChange={e => setQty(e.target.value)}
                className="w-16 text-center bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
              <button onClick={() => setQty(q => Math.min(max, (Number(q) || 0) + 1))} className="w-9 h-9 rounded-lg bg-[var(--bg-input)] text-[var(--text-primary)] flex items-center justify-center"><Plus size={14} /></button>
            </div>
          </div>
          <div className="flex-1">
            <label className="text-[var(--text-muted)] text-xs mb-1 block">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>
        </div>

        <label className="text-[var(--text-muted)] text-xs mb-1 block">Note {reason === 'other' ? <span className="text-red-400">*</span> : '(optional)'}</label>
        <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. packet torn in transit"
          className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />

        {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
        <button onClick={save} disabled={saving || !sel}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5">
          {saving ? 'Saving...' : `Remove ${Number(qty) || 0} pcs from stock`}
        </button>
      </div>
    </div>,
    document.body
  )
}
