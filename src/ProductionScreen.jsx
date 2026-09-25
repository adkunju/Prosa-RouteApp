import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { daysUntilDate } from './dbUtils'
import { Plus, X, FlaskConical, AlertTriangle, Pencil, Trash2, PackageMinus } from 'lucide-react'
import { fetchBatchUsage, notifyStockChanged, reasonLabel } from './stockUtils'
import StockAdjustModal from './StockAdjustModal'
import BatchSummaryModal from './BatchSummaryModal'

// Days until expires_on by calendar date. expires_on is the first day the batch can't be
// sold (produced_on + shelf life), so 1 = today is the last selling day, 0 or less = expired.
function daysLeft(expiresOn) {
  return daysUntilDate(expiresOn)
}

function ExpiryBadge({ days }) {
  if (days <= 0) return <span className="text-xs bg-red-900/60 text-red-300 px-2 py-0.5 rounded-full">Expired</span>
  if (days === 1) return <span className="text-xs bg-[var(--bg-orange-surface)]/60 text-[var(--text-amber2)] px-2 py-0.5 rounded-full">Last day</span>
  if (days <= 2) return <span className="text-xs bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded-full">{days}d left</span>
  return <span className="text-xs bg-[var(--bg-input)] text-[var(--text-secondary)] px-2 py-0.5 rounded-full">{days}d left</span>
}

export default function ProductionScreen() {
  const [batches, setBatches] = useState([])
  const [skus, setSkus] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const [form, setForm] = useState({ sku_id: '', qty: '', produced_on: localDate() })
  const [editingBatch, setEditingBatch] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [prefill, setPrefill] = useState(null)
  const [creating, setCreating] = useState(false)
  const [adjustBatch, setAdjustBatch] = useState(null)
  const [adjustments, setAdjustments] = useState([])
  const [undoingId, setUndoingId] = useState(null)
  const [summaryBatch, setSummaryBatch] = useState(null)
  const [actionError, setActionError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  async function load() {
    const [{ data: b }, { data: s }, { used, delivered, adjusted }, { data: adj }, { data: rets }] = await Promise.all([
      supabase.from('production_batches').select('*, skus(name, shelf_life_days)').order('produced_on', { ascending: false }).limit(40),
      supabase.from('skus').select('id, name').eq('is_active', true).order('name'),
      fetchBatchUsage(),
      supabase.from('stock_adjustments').select('id, qty, reason, notes, adjusted_on, created_at, skus(name), production_batches(produced_on)')
        .order('adjusted_on', { ascending: false }).order('created_at', { ascending: false }).limit(20),
      // returns that came back from each batch (via the delivery they were linked to)
      supabase.from('returns').select('qty_returned, delivery_lines!inner(batch_id)').not('delivery_line_id', 'is', null),
    ])
    const returnedByBatch = {}
    ;(rets || []).forEach(r => { const id = r.delivery_lines?.batch_id; if (id) returnedByBatch[id] = (returnedByBatch[id] || 0) + (r.qty_returned || 0) })
    if (b) setBatches(b.map(batch => ({ ...batch, consumed: delivered[batch.id] || 0, adjusted: adjusted[batch.id] || 0, returned: returnedByBatch[batch.id] || 0, available: batch.qty - (used[batch.id] || 0) })))
    if (s) setSkus(s)
    setAdjustments(adj || [])
  }

  useEffect(() => { load() }, [])

  async function undoAdjustment(id) {
    setUndoingId(id)
    await supabase.from('stock_adjustments').delete().eq('id', id)
    notifyStockChanged()
    await load()
    setUndoingId(null)
  }

  useEffect(() => {
    const raw = sessionStorage.getItem('prosa_production_prefill')
    if (raw) { try { setPrefill(JSON.parse(raw)) } catch { /* ignore */ } }
  }, [])

  // Turn the allocation totals into one batch per SKU.
  async function createFromAllocation() {
    if (!prefill || creating) return
    setCreating(true); setActionError('')
    const { data: { user } } = await supabase.auth.getUser()
    // Look products up now (don't depend on the list having finished loading)
    const { data: allSkus, error: skuErr } = await supabase.from('skus').select('id, name')
    if (!user || skuErr) { setCreating(false); setActionError('Not connected — production was NOT saved. Try again.'); return }
    const rows = [], missing = []
    for (const row of prefill.totals) {
      const sku = (allSkus || []).find(x => x.id === row.sku_id || x.name === row.sku_name)
      if (!sku) { missing.push(row.sku_name); continue }
      if (Number(row.qty) > 0) rows.push({ user_id: user.id, sku_id: sku.id, qty: Number(row.qty), produced_on: prefill.date })
    }
    if (missing.length) { setCreating(false); setActionError(`Product not found: ${missing.join(', ')} — nothing saved.`); return }
    const { error } = await supabase.from('production_batches').insert(rows) // all or nothing
    if (error) { setCreating(false); setActionError('Production was NOT saved: ' + error.message); return }
    sessionStorage.removeItem('prosa_production_prefill')
    setPrefill(null)
    notifyStockChanged()
    window.dispatchEvent(new CustomEvent('prosa:production_confirmed'))
    const ret = sessionStorage.getItem('prosa_settings_return')
    if (ret) {
      sessionStorage.removeItem('prosa_settings_return')
      const [screen, tab] = ret.split(':')
      window.dispatchEvent(new CustomEvent('prosa:goto', { detail: { screen, tab } }))
    }
    setCreating(false)
    await load()
  }

  async function saveBatch() {
    if (!form.sku_id || !form.qty) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSaving(false); setActionError('Not connected — try again'); return }
    const { error } = await supabase.from('production_batches').insert({
      user_id: user.id,
      sku_id: form.sku_id,
      qty: Number(form.qty),
      produced_on: form.produced_on,
    })
    setSaving(false)
    if (error) { setActionError('Batch was NOT saved: ' + error.message); return }
    notifyStockChanged()
    await load(); resetForm()
  }

  async function saveEdit() {
    if (!editingBatch) return
    const orig = batches.find(x => x.id === editingBatch.id)
    const used = (orig?.consumed || 0) + (orig?.adjusted || 0)
    if (Number(editingBatch.qty) < used) {
      setActionError(`Can't set below ${used} — that many are already delivered or adjusted from this batch.`); return
    }
    const { error } = await supabase.from('production_batches').update({
      qty: Number(editingBatch.qty),
      produced_on: editingBatch.produced_on,
    }).eq('id', editingBatch.id)
    if (error) { setActionError('Edit was NOT saved: ' + error.message); return }
    setEditingBatch(null); setActionError('')
    notifyStockChanged()
    await load()
  }

  // Two taps to delete. A batch that already has deliveries can't be deleted (edit it instead).
  async function deleteBatch(id) {
    const b = batches.find(x => x.id === id)
    if (b?.consumed > 0) { setActionError('This batch has deliveries — it can\'t be deleted. Edit the quantity instead.'); return }
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); setTimeout(() => setConfirmDeleteId(c => (c === id ? null : c)), 3000); return }
    setConfirmDeleteId(null)
    setDeletingId(id)
    const { error } = await supabase.from('production_batches').delete().eq('id', id)
    if (error) setActionError('Delete failed: ' + error.message)
    else notifyStockChanged()
    await load()
    setDeletingId(null)
  }

  function resetForm() {
    setShowForm(false)
    setForm({ sku_id: '', qty: '', produced_on: localDate() })
  }

  const activeBatches = batches.filter(b => daysLeft(b.expires_on) > 0)
  // Batches only, newest production first. Adjustments and returns live inside each batch (tap to see).
  const timeline = batches.map(b => ({ kind: 'batch', id: b.id, date: b.produced_on, created: b.created_at || '', b }))
    .sort((x, y) => y.date.localeCompare(x.date) || y.created.localeCompare(x.created))
  const usage = b => (
    <>
      {b.consumed > 0 && <span>{b.consumed} delivered</span>}
      {b.returned > 0 && <span className="text-[var(--text-amber)]"> ↩ {b.returned}</span>}
      {b.adjusted > 0 && <span className="text-[var(--text-amber)]">{b.consumed > 0 ? ' · ' : ''}{b.adjusted} adjusted out</span>}
    </>
  )

  const banner = prefill && (
    <div className="mx-4 mt-4 bg-[var(--bg-card)]/60 border border-[var(--accent)]/40 rounded-2xl p-4">
      <div className="text-[var(--text-primary)] text-sm font-medium mb-1">Production from allocation</div>
      <p className="text-[var(--text-muted2)] text-xs mb-3">For {prefill.date}</p>
      {prefill.totals.map(t => (
        <div key={t.sku_name} className="flex justify-between text-sm py-1 border-t border-[var(--bg-input)]/40">
          <span className="text-[var(--text-secondary)]">{t.sku_name}</span>
          <span className="text-[var(--text-accent)] font-semibold">{t.qty} pcs</span>
        </div>
      ))}
      <div className="flex gap-2 mt-3">
        <button onClick={createFromAllocation} disabled={creating}
          className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-medium rounded-xl py-2.5 transition-colors">
          {creating ? 'Creating...' : 'Confirm production'}
        </button>
        <button onClick={() => { sessionStorage.removeItem('prosa_production_prefill'); setPrefill(null) }}
          className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3">Dismiss</button>
      </div>
    </div>
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {banner}
      {actionError && (
        <div onClick={() => setActionError('')} className="mx-4 mt-3 bg-red-900/40 border border-red-500/40 text-red-200 text-xs rounded-xl px-3 py-2">{actionError}</div>
      )}
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
        <span className="text-[var(--text-muted)] text-sm">{activeBatches.length} active batch{activeBatches.length !== 1 ? 'es' : ''}</span>
        <button
          onClick={() => setShowForm(true)}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
        >
          <Plus size={15} /> Log production
        </button>
      </div>

      {/* Batch list */}
      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-3">
        {activeBatches.length === 0 && !showForm && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <FlaskConical size={40} className="mx-auto mb-3 opacity-40" />
            <p>No active batches</p>
            <p className="text-sm mt-1">Log today's production to get started</p>
          </div>
        )}

        {/* Production log: batches newest first; tap a batch for where it went */}
        {timeline.map(e => (
          <div key={e.kind + e.id} onClick={() => setSummaryBatch(e.b)} role="button" className="cursor-pointer">
            {daysLeft(e.b.expires_on) > 0 ? (() => { const b = e.b; return (
          <div key={b.id} className="bg-[var(--bg-card)] rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-[var(--text-primary)] font-medium">{b.skus?.name}</div>
                <div className="text-[var(--text-muted)] text-sm mt-0.5">
                  {b.available} available <span className="text-[var(--text-faint)]">/ {b.qty} produced</span> · {b.produced_on}
                </div>
                {(b.consumed > 0 || b.adjusted > 0) && (
                  <div className="text-[var(--text-muted2)] text-xs mt-0.5">{usage(b)}</div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0" onClick={ev => ev.stopPropagation()}>
                <ExpiryBadge days={daysLeft(b.expires_on)} />
                {b.available > 0 && (
                  <button onClick={() => setAdjustBatch({ id: b.id, sku_id: b.sku_id })} title="Adjust stock" className="text-[var(--text-muted2)] hover:text-[var(--text-amber)]">
                    <PackageMinus size={15} />
                  </button>
                )}
                <button onClick={() => setEditingBatch({ id: b.id, qty: b.qty, produced_on: b.produced_on })} className="text-[var(--text-muted2)] hover:text-[var(--text-accent)]">
                  <Pencil size={14} />
                </button>
                <button onClick={() => deleteBatch(b.id)} disabled={deletingId === b.id}
                  className={confirmDeleteId === b.id ? 'text-red-400 text-xs font-medium' : 'text-[var(--text-muted2)] hover:text-red-400'}>
                  {confirmDeleteId === b.id ? 'Tap to delete' : <Trash2 size={14} />}
                </button>
              </div>
            </div>
          </div>
            ) })() : (
              <div className="bg-[var(--bg-card)]/50 rounded-xl p-4 opacity-60">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[var(--text-secondary)] font-medium">{e.b.skus?.name}</div>
                    <div className="text-[var(--text-muted2)] text-sm mt-0.5">{e.b.qty} produced · {e.b.produced_on}</div>
                    <div className="text-[var(--text-muted2)] text-xs mt-0.5">{usage(e.b)}</div>
                  </div>
                  <ExpiryBadge days={daysLeft(e.b.expires_on)} />
                </div>
              </div>
            )}
          </div>
        ))}

        {editingBatch && (
          <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/95 flex items-end">
            <div className="bg-[var(--bg-card)] rounded-t-2xl p-4 pb-24 w-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[var(--text-primary)] font-semibold">Edit Batch</h3>
                <button onClick={() => setEditingBatch(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
              </div>
              <label className="text-[var(--text-muted)] text-xs mb-1 block">Quantity</label>
              <input type="number" value={editingBatch.qty}
                onChange={e => setEditingBatch(eb => ({ ...eb, qty: e.target.value }))}
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />
              <label className="text-[var(--text-muted)] text-xs mb-1 block">Produced on</label>
              <input type="date" value={editingBatch.produced_on}
                onChange={e => setEditingBatch(eb => ({ ...eb, produced_on: e.target.value }))}
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-4" />
              <button onClick={saveEdit} className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white font-semibold rounded-lg py-2.5">Save</button>
            </div>
          </div>
        )}

        {summaryBatch && <BatchSummaryModal batch={summaryBatch} onClose={() => setSummaryBatch(null)} onChanged={load} />}
        {adjustBatch && <StockAdjustModal batch={adjustBatch} onClose={() => setAdjustBatch(null)} onSaved={load} />}

      </div>

      {/* Form */}
      {showForm && (
        <div className="absolute bottom-0 left-0 right-0 bg-[var(--bg-card)] border-t border-[var(--bg-input)] rounded-t-2xl p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[var(--text-primary)] font-semibold">Log Production</h2>
            <button onClick={resetForm} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-[var(--text-muted)] text-xs mb-1 block">Product</label>
              <select
                value={form.sku_id} onChange={e => setField('sku_id', e.target.value)}
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
              >
                <option value="">Select a product...</option>
                {skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Quantity (pcs)</label>
                <input
                  type="number" placeholder="0"
                  value={form.qty} onChange={e => setField('qty', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  autoFocus
                />
              </div>
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Date</label>
                <input
                  type="date"
                  value={form.produced_on} onChange={e => setField('produced_on', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
            </div>
            <button
              onClick={saveBatch} disabled={!form.sku_id || !form.qty || saving}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 transition-colors mt-1"
            >
              {saving ? 'Saving...' : 'Save Batch'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
