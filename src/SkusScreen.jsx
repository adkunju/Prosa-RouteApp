import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, Package } from 'lucide-react'

export default function SkusScreen() {
  const [skus, setSkus] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ name: '', unit: 'pcs', shelf_life_days: 6, unit_cost: '', unit_price: '', min_delivery_qty: 1 })

  async function loadSkus() {
    const { data } = await supabase.from('skus').select('*').eq('is_active', true).order('name')
    if (data) setSkus(data)
  }

  useEffect(() => { loadSkus() }, [])

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function saveSku() {
    if (!form.name) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('skus').insert({
      user_id: user.id,
      name: form.name,
      unit: form.unit,
      shelf_life_days: Number(form.shelf_life_days),
      min_delivery_qty: Number(form.min_delivery_qty) || 1,
      unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
      unit_price: form.unit_price ? Number(form.unit_price) : null,
    })
    if (!error) { await loadSkus(); resetForm() }
    setSaving(false)
  }

  function resetForm() {
    setShowForm(false)
    setForm({ name: '', unit: 'pcs', shelf_life_days: 6, unit_cost: '', unit_price: '', min_delivery_qty: 1 })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between">
        <span className="text-[var(--text-muted)] text-sm">{skus.length} SKU{skus.length !== 1 ? 's' : ''}</span>
        <button
          onClick={() => setShowForm(true)}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
        >
          <Plus size={15} /> Add SKU
        </button>
      </div>

      {/* SKU list */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {skus.length === 0 && !showForm && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No SKUs yet</p>
            <p className="text-sm mt-1">Add your products to get started</p>
          </div>
        )}
        {skus.map(sku => (
          <div key={sku.id} className="bg-[var(--bg-card)] rounded-xl p-4 flex items-start justify-between">
            <div>
              <div className="text-[var(--text-primary)] font-medium">{sku.name}</div>
              <div className="text-[var(--text-muted)] text-sm mt-0.5">
                {sku.shelf_life_days} day shelf life · sold per {sku.unit}{sku.min_delivery_qty > 1 ? ` · min ${sku.min_delivery_qty}/drop` : ''}
              </div>
              {(sku.unit_cost || sku.unit_price) && (
                <div className="text-[var(--text-muted2)] text-xs mt-1">
                  {sku.unit_cost ? `Cost ₹${sku.unit_cost}` : ''}
                  {sku.unit_cost && sku.unit_price ? ' · ' : ''}
                  {sku.unit_price ? `Price ₹${sku.unit_price}` : ''}
                </div>
              )}
            </div>
            <span className="text-xs bg-[var(--bg-input)] text-[var(--text-secondary)] px-2 py-1 rounded-full">
              {sku.shelf_life_days}d
            </span>
          </div>
        ))}
      </div>

      {/* Add SKU form */}
      {showForm && (
        <div className="absolute bottom-0 left-0 right-0 bg-[var(--bg-card)] border-t border-[var(--bg-input)] rounded-t-2xl p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[var(--text-primary)] font-semibold">Add SKU</h2>
            <button onClick={resetForm} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>

          <div className="flex flex-col gap-3">
            <input
              type="text" placeholder="Product name *"
              value={form.name} onChange={e => setField('name', e.target.value)}
              className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
              autoFocus
            />
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Unit</label>
                <input
                  type="text" placeholder="pcs / kg / box"
                  value={form.unit} onChange={e => setField('unit', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Shelf life (days)</label>
                <input
                  type="number"
                  value={form.shelf_life_days} onChange={e => setField('shelf_life_days', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Min per drop</label>
                <input
                  type="number" min="1"
                  value={form.min_delivery_qty} onChange={e => setField('min_delivery_qty', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Unit cost (₹)</label>
                <input
                  type="number" placeholder="0.00"
                  value={form.unit_cost} onChange={e => setField('unit_cost', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div className="flex-1">
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Unit price (₹)</label>
                <input
                  type="number" placeholder="0.00"
                  value={form.unit_price} onChange={e => setField('unit_price', e.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
            </div>
            <button
              onClick={saveSku} disabled={!form.name || saving}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 transition-colors mt-1"
            >
              {saving ? 'Saving...' : 'Save SKU'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
