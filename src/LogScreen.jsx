import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, CheckCircle, Trash2, ChevronDown, Save, PackageMinus } from 'lucide-react'
import { notifyStockChanged, reasonLabel } from './stockUtils'
import StockAdjustModal from './StockAdjustModal'

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const today = () => localDate()
function emptyLine(id) {
  return { id, sku_id: '', type: 'sale', produced_on: '', qty: '' }
}

export default function LogScreen() {
  const [stores, setStores] = useState([])
  const [skus, setSkus] = useState([])
  const [batches, setBatches] = useState([])
  const [recentVisits, setRecentVisits] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [store_id, setStoreId] = useState('')
  const [editingLine, setEditingLine] = useState(null) // {id, sku_id, batch_id, produced_on, qty_delivered, qty_returned, type, unit_price, is_offer, plan_stop_id, store_name, delivered_on, return_id}
  const [date, setDate] = useState(today())
  const [lines, setLines] = useState([emptyLine(1)])
  const [nextId, setNextId] = useState(2)
  const [deleting, setDeleting] = useState(null)
  const [adjustments, setAdjustments] = useState([])
  const [showAdjust, setShowAdjust] = useState(false)

  async function load() {
    const [{ data: st }, { data: sk }, { data: ba }, { data: rv }, { data: adj }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').gt('expires_on', today()).order('expires_on'),
      supabase.from('delivery_lines')
        .select('id, delivered_on, qty_delivered, unit_price, is_offer, sku_id, plan_stop_id, store_id, skus(name), plan_stops(store_id, stores(name)), store:stores!delivery_lines_store_id_fkey(name), returns(id, qty_returned), production_batches(produced_on)')
        .order('delivered_on', { ascending: false }).limit(40),
      supabase.from('stock_adjustments').select('id, qty, reason, notes, adjusted_on, skus(name), production_batches(produced_on)')
        .order('adjusted_on', { ascending: false }).order('created_at', { ascending: false }).limit(40),
    ])
    if (st) setStores(st)
    if (sk) setSkus(sk)
    if (ba) setBatches(ba)
    if (rv) setRecentVisits(rv)
    // Only show adjustments within the date span the visit list covers (older ones are on the Production screen)
    const oldestVisit = rv?.length === 40 ? rv[rv.length - 1].delivered_on : ''
    setAdjustments((adj || []).filter(a => a.adjusted_on >= oldestVisit))
  }

  async function undoAdjustment(id) {
    setDeleting(id)
    await supabase.from('stock_adjustments').delete().eq('id', id)
    notifyStockChanged()
    await load()
    setDeleting(null)
  }

  useEffect(() => { load() }, [])

  function addLine() { setLines(l => [...l, emptyLine(nextId)]); setNextId(n => n + 1) }
  function removeLine(id) { setLines(l => l.filter(x => x.id !== id)) }
  function setLineField(id, field, value) {
    setLines(l => l.map(x => x.id === id ? { ...x, [field]: value } : x))
  }
  function batchesForSku(sku_id) { return batches.filter(b => b.sku_id === sku_id) }

  function lineValid(line) {
    if (!line.sku_id || !line.qty || !line.produced_on) return false
    return true
  }
  async function saveEdit() {
    if (!editingLine) return
    const batch = batchesForSku(editingLine.sku_id).find(b => b.produced_on === editingLine.produced_on)
    await supabase.from('delivery_lines').update({
      sku_id: editingLine.sku_id,
      batch_id: batch?.id || editingLine.batch_id || null,
      qty_delivered: editingLine.type === 'return' ? 0 : (Number(editingLine.qty_delivered) || 0),
      unit_price: editingLine.unit_price === '' ? null : Number(editingLine.unit_price),
      is_offer: editingLine.is_offer || false,
    }).eq('id', editingLine.id)
    if (editingLine.type === 'return') {
      const qty = Number(editingLine.qty_returned) || 0
      if (editingLine.return_id) {
        await supabase.from('returns').update({ qty_returned: qty, returned_on: editingLine.delivered_on }).eq('id', editingLine.return_id)
      } else {
        await supabase.from('returns').insert({ delivery_line_id: editingLine.id, qty_returned: qty, returned_on: editingLine.delivered_on, possible_stockout: false })
      }
    } else {
      if (editingLine.return_id) {
        await supabase.from('returns').delete().eq('id', editingLine.return_id)
      }
    }
    setEditingLine(null)
    load()
  }

  function formValid() { return store_id && lines.every(lineValid) }

  function resetForm() {
    setShowForm(false); setStoreId(''); setDate(today())
    setLines([emptyLine(1)]); setNextId(2)
  }

  async function deleteVisit(deliveryLineId, returnIds, storeId, deliveredOn) {
    setDeleting(deliveryLineId)
    for (const rid of returnIds) {
      await supabase.from('returns').delete().eq('id', rid)
    }
    // Also sweep any returns entered during THIS visit — the return may point
    // to an older delivery_line (returns follow the batch that actually expired),
    // so linking by delivery_line_id misses them. Match by store + return date.
    if (storeId && deliveredOn) {
      await supabase.from('returns').delete()
        .eq('store_id', storeId)
        .eq('returned_on', deliveredOn)
    }
    await supabase.from('delivery_lines').delete().eq('id', deliveryLineId)
    await load()
    setDeleting(null)
  }

  async function saveVisit() {
    if (!formValid()) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()

    let planId
    const { data: ep } = await supabase.from('plans').select('id').eq('user_id', user.id).eq('plan_date', date).maybeSingle()
    if (ep) { planId = ep.id } else {
      const { data: np } = await supabase.from('plans').insert({ user_id: user.id, plan_date: date, status: 'completed' }).select('id').single()
      planId = np?.id
    }
    if (!planId) { setSaving(false); return }

    // Reuse existing stop — plan_stops has UNIQUE(plan_id, store_id)
    const { data: existingStop } = await supabase.from('plan_stops')
      .select('id').eq('plan_id', planId).eq('store_id', store_id).maybeSingle()
    let stop
    if (existingStop) {
      stop = existingStop
    } else {
      const { count } = await supabase.from('plan_stops').select('id', { count: 'exact', head: true }).eq('plan_id', planId)
      const { data: newStop } = await supabase.from('plan_stops')
        .insert({ plan_id: planId, store_id, stop_order: (count || 0) + 1 })
        .select('id').single()
      stop = newStop
    }
    if (!stop) { setSaving(false); return }

    for (const line of lines) {
      const batch = batchesForSku(line.sku_id).find(b => b.produced_on === line.produced_on)
      if (line.type === 'sale') {
        await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: Number(line.qty), delivered_on: date,
        })
      } else {
        const { data: dl } = await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: 0, delivered_on: date,
        }).select('id').single()
        if (dl) await supabase.from('returns').insert({
          delivery_line_id: dl.id, qty_returned: Number(line.qty),
          returned_on: date, possible_stockout: false,
        })
      }
    }

    await load(); setSaving(false); setSaved(true)
    setTimeout(() => { setSaved(false); resetForm() }, 1200)
  }

  const grouped = recentVisits.reduce((acc, v) => {
    const d = v.delivered_on; if (!acc[d]) acc[d] = []; acc[d].push(v); return acc
  }, {})
  const adjByDate = adjustments.reduce((acc, a) => {
    const d = a.adjusted_on; if (!acc[d]) acc[d] = []; acc[d].push(a); if (!grouped[d]) grouped[d] = []; return acc
  }, {})

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
        <span className="text-[var(--text-muted)] text-sm">Delivery log</span>
        <div className="flex items-center gap-2">
        <button onClick={() => setShowAdjust(true)}
          className="bg-[var(--bg-input)] text-[var(--text-amber)] text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5">
          <PackageMinus size={15} /> Adjust
        </button>
        <button onClick={() => setShowForm(true)}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors">
          <Plus size={15} /> Log visit
        </button>
        </div>
      </div>
      {showAdjust && <StockAdjustModal onClose={() => setShowAdjust(false)} onSaved={load} />}

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-4">
        {Object.keys(grouped).length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <CheckCircle size={40} className="mx-auto mb-3 opacity-40" />
            <p>No deliveries logged yet</p>
          </div>
        )}
        {Object.entries(grouped).sort(([a],[b]) => b.localeCompare(a)).map(([d, lines]) => (
          <div key={d}>
            <div className="text-[var(--text-muted2)] text-xs font-medium mb-2 uppercase tracking-wide">{d}</div>
            <div className="flex flex-col gap-2">
              {(adjByDate[d] || []).map(a => (
                <div key={a.id} className="bg-[var(--bg-card)] rounded-xl px-4 py-3 border-l-2 border-[var(--text-amber)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--text-primary)] text-sm font-medium flex items-center gap-1.5">
                        <PackageMinus size={13} className="text-[var(--text-amber)]" /> Stock adjusted
                      </div>
                      <div className="text-[var(--text-muted)] text-xs mt-0.5">
                        {a.skus?.name} · −{a.qty} pcs · <span className="text-[var(--text-amber)]">{reasonLabel(a.reason)}</span>
                        {a.production_batches?.produced_on && <span className="text-[var(--text-muted2)]"> · batch {a.production_batches.produced_on}</span>}
                        {a.notes && <span className="text-[var(--text-muted2)]"> · {a.notes}</span>}
                      </div>
                    </div>
                    <button onClick={() => undoAdjustment(a.id)} disabled={deleting === a.id}
                      className="text-[var(--text-faint)] hover:text-red-400 transition-colors shrink-0">
                      {deleting === a.id ? '...' : <Trash2 size={15} />}
                    </button>
                  </div>
                </div>
              ))}
              {lines.map(line => (
                <div key={line.id} className="bg-[var(--bg-card)] rounded-xl px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--text-primary)] text-sm font-medium truncate">{line.plan_stops?.stores?.name || line.store?.name || 'Unknown store'}</div>
                      <div className="text-[var(--text-muted)] text-xs mt-0.5">
                        {line.skus?.name}
                        {line.qty_delivered > 0 && ` · ${line.qty_delivered} sold`}
                        {line.unit_price && ` · ₹${line.unit_price}`}
                        {line.is_offer && <span className="text-[var(--text-gold)] ml-1">OFFER</span>}
                        {line.returns?.length > 0 && ` · ${line.returns[0].qty_returned} returned`}
                        {line.production_batches?.produced_on && (
                          <span className="text-[var(--text-muted2)]"> · batch {line.production_batches.produced_on}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => setEditingLine({
                          id: line.id,
                          sku_id: line.sku_id,
                          batch_id: line.batch_id,
                          produced_on: line.production_batches?.produced_on || '',
                          qty_delivered: line.qty_delivered,
                          qty_returned: line.returns?.[0]?.qty_returned || '',
                          type: (line.returns?.length > 0) ? 'return' : 'sale',
                          unit_price: line.unit_price ?? '',
                          is_offer: line.is_offer || false,
                          plan_stop_id: line.plan_stop_id,
                          store_name: line.plan_stops?.stores?.name || line.store?.name || 'Unknown store',
                          delivered_on: line.delivered_on,
                          return_id: line.returns?.[0]?.id || null,
                        })}
                        className="text-[var(--text-muted2)] hover:text-[var(--accent)] text-xs transition-colors">
                        Edit
                      </button>
                      <button onClick={() => deleteVisit(line.id, line.returns?.map(r => r.id) || [], line.store_id || line.plan_stops?.store_id, line.delivered_on)}
                        disabled={deleting === line.id}
                        className="text-[var(--text-faint)] hover:text-red-400 transition-colors">
                        {deleting === line.id ? '...' : <Trash2 size={15} />}
                      </button>
                    </div>
                  </div>

                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editingLine && (
        <div className="absolute inset-0 bg-[var(--bg-root)] flex flex-col z-10">
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
            <h2 className="text-[var(--text-primary)] font-semibold">Edit Entry</h2>
            <button onClick={() => setEditingLine(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-3">
            <div className="bg-[var(--bg-card)] rounded-xl px-4 py-3 flex justify-between items-center">
              <span className="text-[var(--text-primary)] text-sm font-medium">{editingLine.store_name}</span>
              <span className="text-[var(--text-muted)] text-xs">{editingLine.delivered_on}</span>
            </div>
            <div className="bg-[var(--bg-card)] rounded-xl p-4 flex flex-col gap-3">
              <span className="text-[var(--text-muted)] text-xs font-medium uppercase tracking-wide">Product</span>
              <div className="relative">
                <select value={editingLine.sku_id}
                  onChange={e => setEditingLine(l => ({ ...l, sku_id: e.target.value, produced_on: '' }))}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none">
                  {skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
              </div>
              <div className="flex rounded-lg overflow-hidden border border-[var(--bg-hover)]">
                <button onClick={() => setEditingLine(l => ({ ...l, type: 'sale' }))}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${editingLine.type === 'sale' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                  Sale
                </button>
                <button onClick={() => setEditingLine(l => ({ ...l, type: 'return' }))}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${editingLine.type === 'return' ? 'bg-[var(--text-amber)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                  Return
                </button>
              </div>
              <div>
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Batch (production date)</label>
                <div className="relative">
                  <select value={editingLine.produced_on}
                    onChange={e => setEditingLine(l => ({ ...l, produced_on: e.target.value }))}
                    disabled={!editingLine.sku_id}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none disabled:opacity-50">
                    <option value="">Select batch...</option>
                    {batchesForSku(editingLine.sku_id).map(b => (
                      <option key={b.id} value={b.produced_on}>{b.produced_on} · expires {b.expires_on} · {b.qty} pcs</option>
                    ))}
                  </select>
                  <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                </div>
                {editingLine.sku_id && batchesForSku(editingLine.sku_id).length === 0 && (
                  <p className="text-[var(--text-gold)] text-xs mt-1">No active batches — original batch may have expired</p>
                )}
              </div>
              {editingLine.type === 'sale' ? (
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Qty sold</label>
                  <input type="number" min="0" value={editingLine.qty_delivered}
                    onChange={e => setEditingLine(l => ({ ...l, qty_delivered: e.target.value }))}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              ) : (
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Qty returned</label>
                  <input type="number" min="0" value={editingLine.qty_returned}
                    onChange={e => setEditingLine(l => ({ ...l, qty_returned: e.target.value }))}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              )}
              {editingLine.type === 'sale' && (
                <>
                  <div>
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Price per unit (₹)</label>
                    <input type="number" min="0" step="0.01" value={editingLine.unit_price}
                      onChange={e => setEditingLine(l => ({ ...l, unit_price: e.target.value }))}
                      className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                  </div>
                  <button onClick={() => setEditingLine(l => ({ ...l, is_offer: !l.is_offer }))}
                    className={`self-start text-xs px-3 py-1.5 rounded-lg border transition-colors ${editingLine.is_offer ? 'bg-[var(--text-gold)]/20 border-[var(--text-gold)] text-[var(--text-gold)]' : 'border-[var(--bg-input)] text-[var(--text-muted2)]'}`}>
                    OFFER PRICE
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            <button onClick={saveEdit}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2">
              <Save size={18} /> Save Changes
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="absolute inset-0 bg-[var(--bg-root)] flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
            <h2 className="text-[var(--text-primary)] font-semibold">Log Visit</h2>
            <button onClick={resetForm} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-3">
            <div className="relative">
              <select value={store_id} onChange={e => setStoreId(e.target.value)}
                className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none">
                <option value="">Select store...</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <ChevronDown size={16} className="absolute right-3 top-3.5 text-[var(--text-muted)] pointer-events-none" />
            </div>

            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />

            <div className="flex flex-col gap-3 mt-1">
              {lines.map(line => (
                <div key={line.id} className="bg-[var(--bg-card)] rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-muted)] text-xs font-medium uppercase tracking-wide">Item</span>
                    {lines.length > 1 && (
                      <button onClick={() => removeLine(line.id)} className="text-[var(--text-muted2)] hover:text-red-400 transition-colors">
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>

                  <div className="relative">
                    <select value={line.sku_id} onChange={e => setLineField(line.id, 'sku_id', e.target.value)}
                      className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none">
                      <option value="">Select product...</option>
                      {skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                  </div>

                  <div className="flex rounded-lg overflow-hidden border border-[var(--bg-hover)]">
                    <button onClick={() => setLineField(line.id, 'type', 'sale')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${line.type === 'sale' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                      Sale
                    </button>
                    <button onClick={() => setLineField(line.id, 'type', 'return')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${line.type === 'return' ? 'bg-[var(--text-amber)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                      Return
                    </button>
                  </div>

                  {/* Production date — dropdown for sale, manual entry for return */}
                  <div>
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Production date *</label>
                    {line.type === 'sale' ? (
                      <>
                        <div className="relative">
                          <select value={line.produced_on} onChange={e => setLineField(line.id, 'produced_on', e.target.value)}
                            disabled={!line.sku_id}
                            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none disabled:opacity-50">
                            <option value="">Select batch...</option>
                            {batchesForSku(line.sku_id).map(b => (
                              <option key={b.id} value={b.produced_on}>
                                {b.produced_on} · expires {b.expires_on} · {b.qty} pcs
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                        </div>
                        {line.sku_id && batchesForSku(line.sku_id).length === 0 && (
                          <p className="text-[var(--text-gold)] text-xs mt-1">⚠ No active batches — log production first</p>
                        )}
                      </>
                    ) : (
                      <input type="date" value={line.produced_on}
                        onChange={e => setLineField(line.id, 'produced_on', e.target.value)}
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                        placeholder="Date stock was produced" />
                    )}
                  </div>

                  <div>
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Quantity</label>
                    <input type="number" placeholder="0" value={line.qty}
                      onChange={e => setLineField(line.id, 'qty', e.target.value)}
                      className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addLine}
              className="flex items-center gap-2 text-[var(--text-accent)] hover:text-[var(--text-accent2)] text-sm font-medium py-2 transition-colors">
              <Plus size={16} /> Add item
            </button>
          </div>

          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            <button onClick={saveVisit} disabled={!formValid() || saving || saved}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2">
              {saved ? <><CheckCircle size={18} /> Saved!</> : saving ? 'Saving...' : 'Save Visit'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
