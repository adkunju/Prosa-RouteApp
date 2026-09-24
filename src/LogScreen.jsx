import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, CheckCircle, Trash2, ChevronDown, Save, PackageMinus } from 'lucide-react'
import { notifyStockChanged, reasonLabel } from './stockUtils'
import { ReminderPicker, saveReminder, EMPTY_REMINDER } from './CallFollowupPrompt'
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
  const [visitReturns, setVisitReturns] = useState([]) // returns by store+sku+returned_on
  const [editSaving, setEditSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editError, setEditError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [reminder, setReminder] = useState(EMPTY_REMINDER)
  const [showAdjust, setShowAdjust] = useState(false)

  async function load() {
    const [{ data: st }, { data: sk }, { data: ba }, { data: rv }, { data: adj }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').gt('expires_on', today()).order('expires_on'),
      supabase.from('delivery_lines')
        .select('id, delivered_on, qty_delivered, unit_price, is_offer, sku_id, plan_stop_id, store_id, skus(name), plan_stops(store_id, stores(name)), store:stores!delivery_lines_store_id_fkey(name), batch_id, returns(id, qty_returned, returned_on, delivery_line_id, produced_on), production_batches(produced_on)')
        .order('delivered_on', { ascending: false }).limit(40),
      supabase.from('stock_adjustments').select('id, qty, reason, notes, adjusted_on, skus(name), production_batches(produced_on)')
        .order('adjusted_on', { ascending: false }).order('created_at', { ascending: false }).limit(40),
    ])
    if (st) setStores(st)
    if (sk) setSkus(sk)
    if (ba) setBatches(ba)
    if (rv) setRecentVisits(rv)
    // Returns picked up at each visit — they're usually linked to an OLDER delivery line
    // (the batch that expired), so fetch them by date and match on store + product + date.
    const oldest = rv?.length ? rv[rv.length - 1].delivered_on : today()
    const { data: vr } = await supabase.from('returns')
      .select('id, qty_returned, returned_on, store_id, sku_id, produced_on, delivery_line_id')
      .gte('returned_on', oldest)
    setVisitReturns(vr || [])
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
  // Deliveries of this product to this store up to the visit date — the batches a return can come from
  async function loadPriorDeliveries(line) {
    const storeId = line.store_id || line.plan_stops?.store_id
    if (!storeId) return
    const { data } = await supabase.from('delivery_lines')
      .select('id, delivered_on, qty_delivered, production_batches(produced_on)')
      .eq('store_id', storeId).eq('sku_id', line.sku_id).gt('qty_delivered', 0)
      .lte('delivered_on', line.delivered_on)
      .order('delivered_on', { ascending: false }).limit(12)
    setEditingLine(l => {
      if (!l || l.id !== line.id) return l
      const older = (data || []).find(d => d.delivered_on < line.delivered_on)
      return { ...l, priorDeliveries: data || [], newReturn: { ...l.newReturn, delivery_line_id: l.newReturn.delivery_line_id || older?.id || '' } }
    })
  }

  async function saveEdit() {
    if (!editingLine || editSaving) return
    const el = editingLine
    setEditError('')
    const delivered = Number(el.qty_delivered) || 0
    if (delivered < 0) return setEditError('Delivered qty cannot be negative')
    const newRetQty = Number(el.newReturn.qty) || 0
    if (newRetQty > 0 && !el.newReturn.delivery_line_id) return setEditError('Pick which batch the new return came from')
    setEditSaving(true)
    // Only change the batch if a different production date was picked
    let batchId = el.batch_id || null
    if (el.produced_on && el.produced_on !== el.orig_produced_on) {
      const b = batchesForSku(el.sku_id).find(x => x.produced_on === el.produced_on)
      if (b) batchId = b.id
    }
    const errs = []
    const { error: e1 } = await supabase.from('delivery_lines').update({
      sku_id: el.sku_id,
      batch_id: batchId,
      qty_delivered: delivered,
      unit_price: el.unit_price === '' || el.unit_price == null ? null : Number(el.unit_price),
      is_offer: el.is_offer || false,
    }).eq('id', el.id)
    if (e1) errs.push(e1.message)
    for (const r of el.returns) {
      const q = Number(r.qty_returned) || 0
      if (r._delete || q === 0) {
        const { error } = await supabase.from('returns').delete().eq('id', r.id)
        if (error) errs.push(error.message)
      } else if (q !== r.orig_qty || r.delivery_line_id !== r.orig_dl) {
        const patch = { qty_returned: q, sku_id: el.sku_id }
        if (r.delivery_line_id !== r.orig_dl) {
          const src = el.priorDeliveries.find(d => d.id === r.delivery_line_id)
          patch.delivery_line_id = r.delivery_line_id
          patch.produced_on = src?.production_batches?.produced_on || null
          patch.produced_on_source = 'user'
        }
        const { error } = await supabase.from('returns').update(patch).eq('id', r.id)
        if (error) errs.push(error.message)
      }
    }
    if (newRetQty > 0) {
      const src = el.priorDeliveries.find(d => d.id === el.newReturn.delivery_line_id)
      const srcBatch = src ? src.production_batches?.produced_on : (el.orig_produced_on || el.produced_on)
      const { error } = await supabase.from('returns').insert({
        delivery_line_id: src ? src.id : el.id, store_id: el.store_id, sku_id: el.sku_id,
        qty_returned: newRetQty, returned_on: el.newReturn.date,
        produced_on: srcBatch || null,
        produced_on_source: srcBatch ? 'user' : null,
        possible_stockout: false,
      })
      if (error) errs.push(error.message)
    }
    setEditSaving(false)
    notifyStockChanged()
    if (errs.length) { setEditError('Some changes did not save: ' + errs.join('; ')); load(); return }
    setEditingLine(null)
    load()
  }

  function formValid() { return store_id && lines.every(lineValid) }

  function resetForm() {
    setShowForm(false); setStoreId(''); setDate(today()); setReminder(EMPTY_REMINDER)
    setLines([emptyLine(1)]); setNextId(2)
  }

  // Deletes one delivery line, the returns linked to it, and returns of the SAME product
  // logged at this store on this date (returns from a visit are often linked to an older
  // delivery line of the batch that expired, so linking by delivery_line_id alone misses them).
  async function deleteVisit(line) {
    if (confirmDelete !== line.id) { setConfirmDelete(line.id); setTimeout(() => setConfirmDelete(c => c === line.id ? null : c), 3000); return }
    setConfirmDelete(null)
    setDeleting(line.id)
    const storeId = line.store_id || line.plan_stops?.store_id
    const ids = (line.returns || []).map(r => r.id)
    if (ids.length) await supabase.from('returns').delete().in('id', ids)
    if (storeId && line.sku_id) {
      await supabase.from('returns').delete()
        .eq('store_id', storeId).eq('sku_id', line.sku_id).eq('returned_on', line.delivered_on)
    }
    const { error } = await supabase.from('delivery_lines').delete().eq('id', line.id)
    if (error) window.console.error('delete failed', error)
    notifyStockChanged()
    await load()
    setDeleting(null)
  }

  async function saveVisit() {
    if (!formValid()) return
    setSaving(true); setSaveError('')
    const { data: { user } } = await supabase.auth.getUser()

    let planId
    const { data: ep } = await supabase.from('plans').select('id').eq('user_id', user.id).eq('plan_date', date).maybeSingle()
    if (ep) { planId = ep.id } else {
      const { data: np } = await supabase.from('plans').insert({ user_id: user.id, plan_date: date, status: 'completed' }).select('id').single()
      planId = np?.id
    }
    if (!planId) { setSaveError('Could not create a plan for this date — check your connection'); setSaving(false); return }

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
    if (!stop) { setSaveError('Could not create the store stop — check your connection'); setSaving(false); return }

    const errs = []
    for (const line of lines) {
      const batch = batchesForSku(line.sku_id).find(b => b.produced_on === line.produced_on)
      if (line.type === 'sale') {
        const { error } = await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, store_id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: Number(line.qty), delivered_on: date,
        })
        if (error) errs.push(error.message)
      } else {
        const { data: dl, error } = await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, store_id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: 0, delivered_on: date,
        }).select('id').single()
        if (error || !dl) { errs.push(error?.message || 'delivery line not created'); continue }
        const { error: rErr } = await supabase.from('returns').insert({
          delivery_line_id: dl.id, store_id, sku_id: line.sku_id,
          qty_returned: Number(line.qty), returned_on: date,
          produced_on: line.produced_on || null, produced_on_source: line.produced_on ? 'user' : null,
          possible_stockout: false,
        })
        if (rErr) errs.push(rErr.message)
      }
    }

    notifyStockChanged()
    if (errs.length) {
      setSaveError('Some lines did not save: ' + errs.join('; ') + '. Check the log before re-entering.')
      await load(); setSaving(false); return
    }
    const remErr = await saveReminder(store_id, reminder)
    if (remErr) { setSaveError('Visit saved, but the call reminder did not: ' + remErr); await load(); setSaving(false); return }
    await load(); setSaving(false); setSaved(true)
    setTimeout(() => { setSaved(false); resetForm() }, 1200)
  }

  const visitKey = (storeId, skuId, d) => `${storeId}|${skuId}|${d}`
  const returnsByVisit = visitReturns.reduce((acc, r) => {
    const k = visitKey(r.store_id, r.sku_id, r.returned_on); (acc[k] = acc[k] || []).push(r); return acc
  }, {})
  const lineStoreId = line => line.store_id || line.plan_stops?.store_id
  // Returns shown for a line = picked up at that visit (same store/product/date) + any linked to it
  function returnsForLine(line) {
    const seen = new Set(), out = []
    ;[...(returnsByVisit[visitKey(lineStoreId(line), line.sku_id, line.delivered_on)] || []), ...(line.returns || [])].forEach(r => {
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
    })
    return out
  }
  const pickedUpQty = line => (returnsByVisit[visitKey(lineStoreId(line), line.sku_id, line.delivered_on)] || []).reduce((n, r) => n + (r.qty_returned || 0), 0)

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
                        {pickedUpQty(line) > 0 && ` · ${pickedUpQty(line)} returned`}
                        {line.production_batches?.produced_on && (
                          <span className="text-[var(--text-muted2)]"> · batch {line.production_batches.produced_on}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => { setEditError(''); setEditingLine({
                          id: line.id,
                          sku_id: line.sku_id,
                          batch_id: line.batch_id,
                          produced_on: line.production_batches?.produced_on || '',
                          orig_produced_on: line.production_batches?.produced_on || '',
                          qty_delivered: line.qty_delivered,
                          unit_price: line.unit_price ?? '',
                          is_offer: line.is_offer || false,
                          store_id: line.store_id || line.plan_stops?.store_id || null,
                          store_name: line.plan_stops?.stores?.name || line.store?.name || 'Unknown store',
                          delivered_on: line.delivered_on,
                          returns: returnsForLine(line).map(r => ({ id: r.id, qty_returned: r.qty_returned, orig_qty: r.qty_returned, returned_on: r.returned_on, produced_on: r.produced_on, delivery_line_id: r.delivery_line_id, orig_dl: r.delivery_line_id, this_visit: r.returned_on === line.delivered_on })).sort((a, b) => a.returned_on.localeCompare(b.returned_on)),
                          newReturn: { qty: '', date: line.delivered_on, delivery_line_id: '', open: false },
                          priorDeliveries: [],
                        }); loadPriorDeliveries(line) }}
                        className="text-[var(--text-muted2)] hover:text-[var(--accent)] text-xs transition-colors">
                        Edit
                      </button>
                      <button onClick={() => deleteVisit(line)}
                        disabled={deleting === line.id}
                        className={`transition-colors ${confirmDelete === line.id ? 'text-red-400 text-xs font-medium' : 'text-[var(--text-faint)] hover:text-red-400'}`}>
                        {deleting === line.id ? '...' : confirmDelete === line.id ? 'Tap to delete' : <Trash2 size={15} />}
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
              <div>
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Batch (production date)</label>
                <div className="relative">
                  <select value={editingLine.produced_on}
                    onChange={e => setEditingLine(l => ({ ...l, produced_on: e.target.value }))}
                    disabled={!editingLine.sku_id}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none disabled:opacity-50">
                    <option value="">{editingLine.orig_produced_on ? 'Keep original' : 'No batch'}</option>
                    {editingLine.orig_produced_on && !batchesForSku(editingLine.sku_id).some(b => b.produced_on === editingLine.orig_produced_on) && (
                      <option value={editingLine.orig_produced_on}>{editingLine.orig_produced_on} · original (expired)</option>
                    )}
                    {batchesForSku(editingLine.sku_id).map(b => (
                      <option key={b.id} value={b.produced_on}>{b.produced_on} · expires {b.expires_on}</option>
                    ))}
                  </select>
                  <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="text-[var(--text-muted)] text-xs mb-1 block">Qty delivered</label>
                <input type="number" min="0" value={editingLine.qty_delivered}
                  onChange={e => setEditingLine(l => ({ ...l, qty_delivered: e.target.value }))}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
              </div>
              {Number(editingLine.qty_delivered) > 0 && (
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
            <div className="bg-[var(--bg-card)] rounded-xl p-4 flex flex-col gap-3">
              <span className="text-[var(--text-muted)] text-xs font-medium uppercase tracking-wide">Returns</span>
              {editingLine.returns.length === 0 && <p className="text-[var(--text-muted2)] text-xs">None</p>}
              {editingLine.returns.map((r, i) => (
                <div key={r.id} className={`flex flex-col gap-1.5 pb-3 border-b border-[var(--bg-input)]/40 ${r._delete ? 'opacity-40' : ''}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-muted)] text-xs">{r.this_visit ? 'Picked up this visit' : `Picked up ${r.returned_on}`}</span>
                    <button onClick={() => setEditingLine(l => ({ ...l, returns: l.returns.map((x, j) => j === i ? { ...x, _delete: !x._delete } : x) }))}
                      className="text-xs text-[var(--text-muted2)] hover:text-red-400">{r._delete ? 'Keep' : 'Remove'}</button>
                  </div>
                  <div className="flex gap-2">
                    <select value={r.delivery_line_id || ''} disabled={r._delete}
                      onChange={e => setEditingLine(l => ({ ...l, returns: l.returns.map((x, j) => j === i ? { ...x, delivery_line_id: e.target.value } : x) }))}
                      className="flex-1 min-w-0 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-xs outline-none">
                      {!editingLine.priorDeliveries.some(d => d.id === r.delivery_line_id) && (
                        <option value={r.delivery_line_id || ''}>Batch {r.produced_on || '?'}</option>
                      )}
                      {editingLine.priorDeliveries.map(d => (
                        <option key={d.id} value={d.id}>Batch {d.production_batches?.produced_on || '?'} (sent {d.delivered_on}, {d.qty_delivered} pcs)</option>
                      ))}
                    </select>
                    <input type="number" min="0" value={r.qty_returned} disabled={r._delete}
                      onChange={e => setEditingLine(l => ({ ...l, returns: l.returns.map((x, j) => j === i ? { ...x, qty_returned: e.target.value } : x) }))}
                      className="w-20 shrink-0 text-center bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--text-amber)]" />
                  </div>
                </div>
              ))}
              {!editingLine.newReturn.open ? (
                <button onClick={() => setEditingLine(l => ({ ...l, newReturn: { ...l.newReturn, open: true } }))}
                  className="self-start text-xs font-medium text-[var(--text-amber)] flex items-center gap-1">
                  <Plus size={13} /> Add a return picked up this visit
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[var(--text-muted)] text-xs">New return · which batch came back?</span>
                  <div className="flex gap-2">
                    <select value={editingLine.newReturn.delivery_line_id}
                      onChange={e => setEditingLine(l => ({ ...l, newReturn: { ...l.newReturn, delivery_line_id: e.target.value } }))}
                      className="flex-1 min-w-0 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-xs outline-none">
                      <option value="">Select batch...</option>
                      {editingLine.priorDeliveries.map(d => (
                        <option key={d.id} value={d.id}>Batch {d.production_batches?.produced_on || '?'} (sent {d.delivered_on}, {d.qty_delivered} pcs)</option>
                      ))}
                    </select>
                    <input type="number" min="0" placeholder="Qty" value={editingLine.newReturn.qty} autoFocus
                      onChange={e => setEditingLine(l => ({ ...l, newReturn: { ...l.newReturn, qty: e.target.value } }))}
                      className="w-20 shrink-0 text-center bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--text-amber)]" />
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            {editError && <p className="text-red-400 text-xs mb-2">{editError}</p>}
            <button onClick={saveEdit} disabled={editSaving}
              className="w-full disabled:opacity-50 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2">
              <Save size={18} /> {editSaving ? 'Saving...' : 'Save Changes'}
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
            <ReminderPicker value={reminder} onChange={setReminder} />
          </div>

          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            {saveError && <p className="text-red-400 text-xs mb-2">{saveError}</p>}
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
