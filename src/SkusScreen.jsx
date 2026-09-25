import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, Package, Pencil } from 'lucide-react'

export default function SkusScreen() {
  const [skus, setSkus] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ name: '', unit: 'pcs', shelf_life_days: 6, unit_cost: '', unit_price: '', min_delivery_qty: 1 })

  async function loadSkus() {
    const { data } = await supabase.from('skus').select('*').eq('is_active', true).order('name')
    if (data) setSkus(data)
  }

  useEffect(() => { loadSkus() }, [])

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function openEdit(sku) {
    setEditingId(sku.id)
    setForm({
      name: sku.name,
      unit: sku.unit || 'pcs',
      shelf_life_days: sku.shelf_life_days,
      unit_cost: sku.unit_cost ?? '',
      unit_price: sku.unit_price ?? '',
      min_delivery_qty: sku.min_delivery_qty || 1,
    })
    setShowForm(true)
  }

  function openAdd() {
    setEditingId(null)
    setForm({ name: '', unit: 'pcs', shelf_life_days: 6, unit_cost: '', unit_price: '', min_delivery_qty: 1 })
    setShowForm(true)
  }

  async function saveSku() {
    if (!form.name) return
    setSaving(true)
    const payload = {
      name: form.name,
      unit: form.unit,
      shelf_life_days: Number(form.shelf_life_days),
      min_delivery_qty: Number(form.min_delivery_qty) || 1,
      unit_cost: form.unit_cost !== '' ? Number(form.unit_cost) : null,
      unit_price: form.unit_price !== '' ? Number(form.unit_price) : null,
    }
    let error
    if (editingId) {
      ({ error } = await supabase.from('skus').update(payload).eq('id', editingId))
    } else {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setSaving(false); alert('Not connected — try again'); return }
      ({ error } = await supabase.from('skus').insert({ user_id: user.id, ...payload }))
    }
    setSaving(false)
    if (error) { alert('Product was NOT saved: ' + error.message); return } // keep the form open
    await loadSkus()
    resetForm()
  }

  function resetForm() {
    setShowForm(false)
    setEditingId(null)
    setForm({ name: '', unit: 'pcs', shelf_life_days: 6, unit_cost: '', unit_price: '', min_delivery_qty: 1 })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between">
        <span className="text-[var(--text-muted)] text-sm">{skus.length} SKU{skus.length !== 1 ? 's' : ''}</span>
        <button onClick={openAdd}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors">
          <Plus size={15} /> Add SKU
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {skus.length === 0 && !showForm && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No SKUs yet</p>
          </div>
        )}
        {skus.map(sku => (
          <div key={sku.id} className="bg-[var(--bg-card)] rounded-xl p-4 flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="text-[var(--text-primary)] font-medium">{sku.name}</div>
              <div className="text-[var(--text-muted)] text-sm mt-0.5">
                {sku.shelf_life_days}d shelf life · per {sku.unit}{sku.min_delivery_qty > 1 ? ` · min ${sku.min_delivery_qty}/drop` : ''}
              </div>
              {(sku.unit_cost || sku.unit_price) && (
                <div className="text-[var(--text-muted2)] text-xs mt-1">
                  {sku.unit_cost ? `Cost ₹${sku.unit_cost}` : ''}
                  {sku.unit_cost && sku.unit_price ? ' · ' : ''}
                  {sku.unit_price ? `Price ₹${sku.unit_price}` : ''}
                </div>
              )}
            </div>
            <button onClick={() => openEdit(sku)}
              className="text-[var(--text-muted2)] hover:text-[var(--accent)] transition-colors ml-3 mt-0.5">
              <Pencil size={16} />
            </button>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/80 backdrop-blur-2xl flex items-center justify-center p-4"
          onClick={resetForm}>
          <div onClick={e => e.stopPropagation()}
            className="bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-5 shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[var(--text-primary)] font-semibold">{editingId ? 'Edit SKU' : 'Add SKU'}</h2>
              <button onClick={resetForm} className="text-[var(--text-muted)]"><X size={20} /></button>
            </div>
            <div className="flex flex-col gap-3">
              <input type="text" placeholder="Product name *"
                value={form.name} onChange={e => setField('name', e.target.value)}
                className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                autoFocus />
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Unit</label>
                  <input type="text" value={form.unit} onChange={e => setField('unit', e.target.value)}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Shelf life (days)</label>
                  <input type="number" value={form.shelf_life_days} onChange={e => setField('shelf_life_days', e.target.value)}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Min/drop</label>
                  <input type="number" min="1" value={form.min_delivery_qty} onChange={e => setField('min_delivery_qty', e.target.value)}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Cost (₹)</label>
                  <input type="number" placeholder="0.00" value={form.unit_cost} onChange={e => setField('unit_cost', e.target.value)}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Default price (₹)</label>
                  <input type="number" placeholder="0.00" value={form.unit_price} onChange={e => setField('unit_price', e.target.value)}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none" />
                </div>
              </div>
              <button onClick={saveSku} disabled={!form.name || saving}
                className="w-full bg-[var(--accent)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 transition-colors">
                {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add SKU'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
