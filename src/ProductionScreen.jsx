import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, FlaskConical, AlertTriangle, Pencil, Trash2 } from 'lucide-react'

function daysLeft(expiresOn) {
  const diff = Math.ceil((new Date(expiresOn) - new Date()) / (1000 * 60 * 60 * 24))
  return diff
}

function ExpiryBadge({ days }) {
  if (days <= 0) return <span className="text-xs bg-red-900/60 text-red-300 px-2 py-0.5 rounded-full">Expired</span>
  if (days === 1) return <span className="text-xs bg-[var(--bg-orange-surface)]/60 text-[var(--text-amber2)] px-2 py-0.5 rounded-full">Expires today</span>
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

  async function load() {
    const [{ data: b }, { data: s }, { data: dl }] = await Promise.all([
      supabase.from('production_batches').select('*, skus(name, shelf_life_days)').order('produced_on', { ascending: false }).limit(40),
      supabase.from('skus').select('id, name').eq('is_active', true).order('name'),
      supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
    ])
    const consumedByBatch = {}
    ;(dl || []).forEach(d => { consumedByBatch[d.batch_id] = (consumedByBatch[d.batch_id] || 0) + d.qty_delivered })
    if (b) setBatches(b.map(batch => ({ ...batch, consumed: consumedByBatch[batch.id] || 0, available: batch.qty - (consumedByBatch[batch.id] || 0) })))
    if (s) setSkus(s)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const raw = sessionStorage.getItem('prosa_production_prefill')
    if (raw) { try { setPrefill(JSON.parse(raw)) } catch { /* ignore */ } }
  }, [])

  // Turn the allocation totals into one batch per SKU.
  async function createFromAllocation() {
    if (!prefill) return
    setCreating(true)
    const { data: { user } } = await supabase.auth.getUser()
    for (const row of prefill.totals) {
      const sku = skus.find(s => s.name === row.sku_name)
      if (!sku) continue
      const { data: skuData } = await supabase.from('skus').select('shelf_life_days').eq('id', sku.id).single()
      const exp = new Date(prefill.date)
      exp.setDate(exp.getDate() + (skuData?.shelf_life_days || 5))
      await supabase.from('production_batches').insert({
        user_id: user.id,
        sku_id: sku.id,
        qty: Number(row.qty),
        produced_on: prefill.date,
        expires_on: localDate(exp),
      })
    }
    sessionStorage.removeItem('prosa_production_prefill')
    setPrefill(null)
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

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function saveBatch() {
    if (!form.sku_id || !form.qty) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const sku = skus.find(s => s.id === form.sku_id)
    const shelfDays = sku ? batches.find(b => b.sku_id === form.sku_id)?.skus?.shelf_life_days : 0
    // get shelf life from skus table
    const { data: skuData } = await supabase.from('skus').select('shelf_life_days').eq('id', form.sku_id).single()
    const expiresOn = new Date(form.produced_on)
    expiresOn.setDate(expiresOn.getDate() + (skuData?.shelf_life_days || 5))

    const { error } = await supabase.from('production_batches').insert({
      user_id: user.id,
      sku_id: form.sku_id,
      qty: Number(form.qty),
      produced_on: form.produced_on,
      expires_on: localDate(expiresOn),
    })
    if (!error) { await load(); resetForm() }
    setSaving(false)
  }

  async function saveEdit() {
    if (!editingBatch) return
    await supabase.from('production_batches').update({
      qty: Number(editingBatch.qty),
      produced_on: editingBatch.produced_on,
    }).eq('id', editingBatch.id)
    setEditingBatch(null)
    await load()
  }

  async function deleteBatch(id) {
    setDeletingId(id)
    await supabase.from('production_batches').delete().eq('id', id)
    await load()
    setDeletingId(null)
  }

  function resetForm() {
    setShowForm(false)
    setForm({ sku_id: '', qty: '', produced_on: localDate() })
  }

  const activeBatches = batches.filter(b => daysLeft(b.expires_on) > 0)
  const expiredBatches = batches.filter(b => daysLeft(b.expires_on) <= 0)

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

        {activeBatches.map(b => (
          <div key={b.id} className="bg-[var(--bg-card)] rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-[var(--text-primary)] font-medium">{b.skus?.name}</div>
                <div className="text-[var(--text-muted)] text-sm mt-0.5">
                  {b.available} available <span className="text-[var(--text-faint)]">/ {b.qty} produced</span> · {b.produced_on}
                </div>
                {b.consumed > 0 && <div className="text-[var(--text-muted2)] text-xs mt-0.5">{b.consumed} delivered so far</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ExpiryBadge days={daysLeft(b.expires_on)} />
                <button onClick={() => setEditingBatch({ id: b.id, qty: b.qty, produced_on: b.produced_on })} className="text-[var(--text-muted2)] hover:text-[var(--text-accent)]">
                  <Pencil size={14} />
                </button>
                <button onClick={() => deleteBatch(b.id)} disabled={deletingId === b.id} className="text-[var(--text-muted2)] hover:text-red-400">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
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

        {expiredBatches.length > 0 && (
          <>
            <div className="flex items-center gap-2 mt-2">
              <AlertTriangle size={14} className="text-[var(--text-muted2)]" />
              <span className="text-[var(--text-muted2)] text-xs">Expired batches</span>
            </div>
            {expiredBatches.slice(0, 5).map(b => (
              <div key={b.id} className="bg-[var(--bg-card)]/50 rounded-xl p-4 opacity-50">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[var(--text-secondary)] font-medium">{b.skus?.name}</div>
                    <div className="text-[var(--text-muted2)] text-sm mt-0.5">{b.qty} pcs · {b.produced_on}</div>
                  </div>
                  <ExpiryBadge days={daysLeft(b.expires_on)} />
                </div>
              </div>
            ))}
          </>
        )}
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
