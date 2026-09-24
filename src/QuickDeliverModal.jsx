import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import DeliveryConfirmed from './DeliveryConfirmed'
import { ReminderPicker, saveReminder, EMPTY_REMINDER } from './CallFollowupPrompt'
import { fetchBatchUsage, notifyStockChanged } from './stockUtils'
import { X, Search, Loader2 } from 'lucide-react'

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const today = () => localDate()


// Token-based fuzzy match: each space-separated token must appear in name
function _tokenMatch(q, name) {
  const t = (q || '').trim().toLowerCase()
  if (!t) return true
  const n = (name || '').toLowerCase()
  return t.split(/\s+/).filter(Boolean).every(x => n.includes(x))
}

export default function QuickDeliverModal({ onClose, onSaved, initialStore }) {
  const [stores, setStores] = useState([])
  const [recentIds, setRecentIds] = useState([])
  const [skus, setSkus] = useState([])
  const [batches, setBatches] = useState([])
  const [query, setQuery] = useState('')
  const [store, setStore] = useState(null)
  const [lines, setLines] = useState({})
  const [selectedSkuIds, setSelectedSkuIds] = useState([])
  const [storeHistory, setStoreHistory] = useState({}) // sku_id -> [{delivered_on, qty, returned, price, is_offer}]
  const [showHistoryFor, setShowHistoryFor] = useState(null)
  const [saving, setSaving] = useState(false)
  const [remark, setRemark] = useState('')
  const [returnSources, setReturnSources] = useState({}) // sku_id -> earlier deliveries a return can come from
  const [saveError, setSaveError] = useState('')
  const [reminder, setReminder] = useState(EMPTY_REMINDER)
  const [deliveryDone, setDeliveryDone] = useState(null)

  useEffect(() => { (async () => {
    const [{ data: st }, { data: sk }, { data: b }, { used }, { data: rdl }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name, unit_price').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').order('produced_on'),
      fetchBatchUsage(),
      supabase.from('delivery_lines').select('store_id, delivered_on').order('delivered_on', { ascending: false }).limit(60),
    ])
    const seen = new Set()
    const recent = []
    ;(rdl||[]).forEach(x => { if (!seen.has(x.store_id)) { seen.add(x.store_id); recent.push(x.store_id) } })
    setRecentIds(recent)
    setStores(st || [])
    setSkus(sk || [])
    setBatches((b || []).map(x => ({ ...x, available: x.qty - (used[x.id] || 0) })))
  })() }, [])

  useEffect(() => {
    if (initialStore && !store && skus.length > 0 && batches.length > 0) {
      pickStore(initialStore)
    }
  }, [initialStore, skus, batches])

  const recentStores = recentIds.slice(0, 8).map(id => stores.find(s => s.id === id)).filter(Boolean)
  const matches = query.trim()
    ? stores.filter(s => _tokenMatch(query, s.name)).slice(0, 8)
    : recentStores

  function batchesFor(skuId) {
    return batches.filter(b => b.sku_id === skuId && b.available > 0 && b.expires_on > today())
  }

  function setLine(skuId, patch) {
    setLines(l => ({ ...l, [skuId]: { ...l[skuId], ...patch } }))
  }
  const retTotal = l => (l?.returns || []).reduce((n, r) => n + (Number(r.qty) || 0), 0)
  function setReturnRow(skuId, idx, patch) {
    setLines(ls => ({ ...ls, [skuId]: { ...ls[skuId], returns: (ls[skuId]?.returns || []).map((r, i) => i === idx ? { ...r, ...patch } : r) } }))
  }
  function addReturnRow(skuId) {
    setLines(ls => ({ ...ls, [skuId]: { ...ls[skuId], returns: [...(ls[skuId]?.returns || []), { dl_id: '', qty: '' }] } }))
  }
  function removeReturnRow(skuId, idx) {
    setLines(ls => ({ ...ls, [skuId]: { ...ls[skuId], returns: (ls[skuId]?.returns || []).filter((_, i) => i !== idx) } }))
  }

  async function pickStore(s) {
    setStore(s)
    // Fetch store-specific prices and last sold prices in parallel
    const [{ data: storePrices }, { data: lastSold }] = await Promise.all([
      supabase.from('store_sku_price_latest').select('sku_id, price').eq('store_id', s.id),
      supabase.from('delivery_lines')
        .select('sku_id, unit_price')
        .eq('store_id', s.id)
        .not('unit_price', 'is', null)
        .order('delivered_on', { ascending: false })
        .limit(20),
    ])
    const storePriceMap = {}
    ;(storePrices || []).forEach(p => { storePriceMap[p.sku_id] = p.price })
    const lastSoldMap = {}
    ;(lastSold || []).forEach(l => { if (!lastSoldMap[l.sku_id]) lastSoldMap[l.sku_id] = l.unit_price })

    const init = {}
    skus.forEach(sk => {
      const price = lastSoldMap[sk.id] ?? storePriceMap[sk.id] ?? sk.unit_price ?? ''
      init[sk.id] = { qty: '', batch_id: batchesFor(sk.id)[0]?.id || '', returns: [{ dl_id: '', qty: '' }], price, is_offer: false, store_balance: '' }
    })
    setRemark('')
    setReminder(EMPTY_REMINDER)
    setLines(init)
    setSelectedSkuIds([])

    // Fetch delivery history for this store
    const [{ data: hist }, { data: rets }] = await Promise.all([
      supabase.from('delivery_lines')
        .select('id, sku_id, qty_delivered, delivered_on, unit_price, is_offer, production_batches(produced_on)')
        .eq('store_id', s.id)
        .order('delivered_on', { ascending: false })
        .limit(80),
      supabase.from('returns')
        .select('delivery_line_id, qty_returned')
        .eq('store_id', s.id),
    ])
    const retsByLine = {}
    ;(rets || []).forEach(r => {
      if (r.delivery_line_id) retsByLine[r.delivery_line_id] = (retsByLine[r.delivery_line_id] || 0) + r.qty_returned
    })
    // Earlier deliveries a return can come from (before today, something was delivered)
    const sources = {}
    ;(hist || []).forEach(l => {
      if (l.qty_delivered <= 0 || l.delivered_on >= today()) return
      if (!sources[l.sku_id]) sources[l.sku_id] = []
      if (sources[l.sku_id].length < 12) sources[l.sku_id].push({
        id: l.id, delivered_on: l.delivered_on, qty: l.qty_delivered,
        produced_on: l.production_batches?.produced_on || null,
        returned: retsByLine[l.id] || 0,
      })
    })
    setReturnSources(sources)
    const grouped = {}
    ;(hist || []).forEach(l => {
      if (!grouped[l.sku_id]) grouped[l.sku_id] = []
      if (grouped[l.sku_id].length < 5) grouped[l.sku_id].push({
        delivered_on: l.delivered_on,
        qty: l.qty_delivered,
        returned: retsByLine[l.id] || 0,
        price: l.unit_price,
        is_offer: l.is_offer,
      })
    })
    setStoreHistory(grouped)
  }

  async function save() {
    if (!store || saving) return
    setSaveError('')
    const dateStr = today()
    const active = selectedSkuIds.filter(id => skus.some(s => s.id === id))
    if (active.some(id => (lines[id]?.returns || []).some(r => Number(r.qty) > 0 && !r.dl_id))) {
      setSaveError('Pick which batch each return came from'); return
    }
    setSaving(true)
    // 1. all delivery lines in one request
    const lineRows = active.filter(id => Number(lines[id]?.qty) > 0).map(id => {
      const l = lines[id]
      return {
        store_id: store.id, plan_stop_id: null, sku_id: id,
        batch_id: l.batch_id || null,
        qty_delivered: Number(l.qty),
        unit_price: l.price === '' || l.price == null ? null : Number(l.price),
        is_offer: l.is_offer || false,
        store_balance: l.store_balance !== '' && l.store_balance !== undefined ? Number(l.store_balance) : null,
        delivered_on: dateStr,
      }
    })
    let inserted = []
    if (lineRows.length) {
      const { data, error } = await supabase.from('delivery_lines').insert(lineRows).select('id')
      if (error) { setSaveError('Could not save: ' + error.message + '. Nothing was recorded — try again.'); setSaving(false); return }
      inserted = data || []
    }
    // 2. returns — each linked to the EARLIER delivery the stock came from, never today's
    const retRows = active.flatMap(id => (lines[id]?.returns || []).filter(r => Number(r.qty) > 0).map(r => {
      const src = r.dl_id !== 'none' ? (returnSources[id] || []).find(x => x.id === r.dl_id) : null
      return {
        delivery_line_id: src ? src.id : null,
        store_id: store.id, sku_id: id,
        produced_on: src?.produced_on || null,
        produced_on_source: src?.produced_on ? 'user' : null,
        qty_returned: Number(r.qty),
        returned_on: dateStr,
        possible_stockout: false,
        reason: src ? null : 'No matching delivery on record',
      }
    }))
    if (retRows.length) {
      const { error } = await supabase.from('returns').insert(retRows)
      if (error) {
        if (inserted.length) await supabase.from('delivery_lines').delete().in('id', inserted.map(d => d.id))
        setSaveError('Could not save returns: ' + error.message + '. Nothing was recorded — try again.')
        setSaving(false); return
      }
    }
    // If visit-only (no delivery) save remark to call_logs via plan_stops is not applicable
    // Record as a store note instead using a simple insert
    if (remark.trim() && !Object.values(lines).some(l => Number(l?.qty) > 0)) {
      // Pure visit — keep the note in the store's log
      await supabase.from('call_logs').insert({ store_id: store.id, kind: 'visit', note: remark.trim(), called_at: new Date().toISOString() })
    }
    const remErr = await saveReminder(store.id, reminder)
    if (remErr) alert('Delivery saved, but the call reminder did not: ' + remErr)
    notifyStockChanged()
    setSaving(false)
    const items = active.map(id => ({
      name: skus.find(s => s.id === id)?.name || 'Item',
      delivered: Number(lines[id]?.qty) || 0,
      returned: retTotal(lines[id]),
      price: Number(lines[id]?.price) || 0,
    })).filter(i => i.delivered > 0 || i.returned > 0)
    if (items.length) { setDeliveryDone({ storeId: store.id, storeName: store.name, date: dateStr, items }); return }
    onSaved?.()
    onClose?.()
  }

  if (deliveryDone) {
    return <DeliveryConfirmed {...deliveryDone} onClose={() => { onSaved?.(); onClose?.() }} />
  }

  const anything = remark.trim().length > 0 || (reminder.open && !!reminder.date) || selectedSkuIds.some(id => Number(lines[id]?.qty) > 0 || retTotal(lines[id]) > 0)

  return (
    <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
        <span className="text-[var(--text-primary)] font-semibold">
          {store ? store.name : 'Quick delivery'}
        </span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28">
        {!store && (
          <>
            {!query && <p className="text-[var(--text-muted2)] text-xs mb-2">Recent stores</p>}
            <div className="relative mb-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]" />
              <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Search store..."
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            </div>
            {matches.map(s => (
              <button key={s.id} onClick={() => pickStore(s)}
                className="w-full text-left bg-[var(--bg-card)]/70 hover:bg-[var(--bg-input)]/60 rounded-xl px-4 py-3 mb-1.5 text-[var(--text-secondary)] text-sm transition-colors">
                {s.name}
              </button>
            ))}
            {!query && matches.length === 0 && (
              <p className="text-[var(--text-muted2)] text-sm text-center mt-6">No recent deliveries</p>
            )}
            {query && matches.length === 0 && (
              <p className="text-[var(--text-muted2)] text-sm text-center mt-6">No store matches that</p>
            )}
          </>
        )}

        {store && (
          <div className="mb-3">
            <label className="text-[var(--text-muted)] text-xs mb-1 block">Remark / visit note</label>
            <textarea value={remark} onChange={e => setRemark(e.target.value)}
              placeholder="Optional — what happened at this visit?"
              rows={2}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none" />
            <div className="mt-3"><ReminderPicker value={reminder} onChange={setReminder} /></div>
          </div>
        )}
        {store && selectedSkuIds.map(skuId => {
          const sk = skus.find(s => s.id === skuId)
          if (!sk) return null
          const l = lines[sk.id] || {}
          const avail = batchesFor(sk.id)
          const hist = storeHistory[sk.id] || []
          return (
            <div key={sk.id} className="bg-[var(--bg-card)]/80 border border-[var(--bg-input)]/40 rounded-xl p-4 mb-3">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[var(--text-primary)] text-sm font-medium">{sk.name}</span>
                <button onClick={() => setSelectedSkuIds(ids => ids.filter(id => id !== skuId))}
                  className="text-[var(--text-muted2)] hover:text-red-400 text-xs">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Delivered</label>
                  <input type="number" min="0" value={l.qty ?? ''}
                    onChange={e => setLine(sk.id, { qty: e.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Returned (total)</label>
                  <div className="w-full bg-[var(--bg-input)]/50 text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm">{retTotal(l)}</div>
                </div>
              </div>
              {(Number(l.qty) > 0 || retTotal(l) > 0) && (
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <label className="text-[var(--text-muted)] text-xs">Price per pc (₹)</label>
                    <button
                      onClick={() => setLine(sk.id, { is_offer: !l.is_offer })}
                      className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-lg border transition-colors ${l.is_offer ? 'bg-[var(--text-gold)]/20 border-[var(--text-gold)] text-[var(--text-gold)]' : 'border-[var(--bg-input)] text-[var(--text-muted2)] hover:border-[var(--text-gold)] hover:text-[var(--text-gold)]'}`}>
                      OFFER
                    </button>
                  </div>
                  <input type="number" min="0" step="0.01" value={l.price ?? ''}
                    onChange={ev => setLine(sk.id, { price: ev.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                  <p className="text-[var(--text-muted2)] text-xs mt-1">
                    Billed {Math.max(0, (Number(l.qty) || 0) - retTotal(l))} pcs
                    {l.price !== '' && ` · ₹${(Math.max(0, (Number(l.qty) || 0) - retTotal(l)) * Number(l.price)).toFixed(2)}`}
                    {l.is_offer && <span className="ml-1 text-[var(--text-gold)]">· offer price</span>}
                  </p>
                  {(() => {
                    const last = (storeHistory[sk.id] || []).find(h => h.price)
                    if (!last) return null
                    return (
                      <p className="text-[var(--text-muted2)] text-[10px] mt-0.5">
                        Last sold: ₹{last.price} on {last.delivered_on}
                        {last.is_offer && <span className="ml-1 text-[var(--text-gold)]">· was offer</span>}
                      </p>
                    )
                  })()}
                </div>
              )}
              {Number(l.qty) > 0 && (
                <div className="mb-2">
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Batch</label>
                  <select value={l.batch_id || ''} onChange={e => setLine(sk.id, { batch_id: e.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]">
                    <option value="">No batch</option>
                    {avail.map(b => (
                      <option key={b.id} value={b.id}>{b.produced_on} · {b.available} pcs left</option>
                    ))}
                  </select>
                  {avail.length === 0 && <p className="text-[var(--text-gold)] text-xs mt-1">No stock in hand for this product</p>}
                </div>
              )}
              <div className="mt-2 flex flex-col gap-2">
                <label className="text-[var(--text-muted)] text-xs">Returns picked up · which batch?</label>
                {(l.returns || []).map((r, idx) => {
                  const src = (returnSources[sk.id] || []).find(x => x.id === r.dl_id)
                  const over = src && Number(r.qty) > src.qty - src.returned
                  return (
                    <div key={idx} className="flex flex-col gap-1">
                      <div className="flex gap-2 items-center">
                        <select value={r.dl_id} onChange={e => setReturnRow(sk.id, idx, { dl_id: e.target.value })}
                          className={`flex-1 min-w-0 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-xs outline-none ${Number(r.qty) > 0 && !r.dl_id ? 'ring-1 ring-red-400' : ''}`}>
                          <option value="">Select batch...</option>
                          {(returnSources[sk.id] || []).map(x => (
                            <option key={x.id} value={x.id}>Batch {x.produced_on || '?'} · sent {x.delivered_on.slice(5)} ({x.qty}{x.returned ? `, ${x.returned} back` : ''})</option>
                          ))}
                          <option value="none">Not on record</option>
                        </select>
                        <input type="number" min="0" placeholder="Qty" value={r.qty}
                          onChange={e => setReturnRow(sk.id, idx, { qty: e.target.value })}
                          className="w-16 shrink-0 text-center bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--text-amber)]" />
                        {(l.returns || []).length > 1 && (
                          <button onClick={() => removeReturnRow(sk.id, idx)} className="text-[var(--text-muted2)] hover:text-red-400 shrink-0 text-xs">✕</button>
                        )}
                      </div>
                      {over && <p className="text-[var(--text-gold)] text-[11px]">More than was left from that delivery ({src.qty - src.returned}) — check the batch</p>}
                    </div>
                  )
                })}
                <button onClick={() => addReturnRow(sk.id)} className="self-start text-xs font-medium text-[var(--text-amber)]">+ Another batch</button>
              </div>
              {hist.length > 0 && (
                <div className="mt-3 border-t border-[var(--bg-input)]/30 pt-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[var(--text-muted)] text-xs">Balance before delivery</label>
                    <input type="number" min="0" placeholder="pcs"
                      value={l.store_balance ?? ''}
                      onChange={e => setLine(sk.id, { store_balance: e.target.value })}
                      className="w-20 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-xs outline-none text-center" />
                  </div>
                  {hist.length > 0 && (
                  <button onClick={() => setShowHistoryFor(showHistoryFor === sk.id ? null : sk.id)}
                    className="text-[var(--text-muted2)] text-[10px] uppercase tracking-wide flex items-center gap-1 w-full mt-1">
                    Recent {showHistoryFor === sk.id ? '▲' : '▼'}
                  </button>)}
                  {showHistoryFor === sk.id && hist.map((h, i) => (
                    <div key={i} className="flex justify-between text-xs py-1 border-t border-[var(--bg-input)]/20 first:border-0">
                      <span className="text-[var(--text-muted2)]">{h.delivered_on}</span>
                      <span className="text-[var(--text-secondary)] flex items-center gap-1.5">
                        {h.qty} pcs
                        {h.returned > 0 && <span className="text-red-400">· {h.returned} ret</span>}
                        {h.price && <span className="text-[var(--text-muted2)]">· ₹{h.price}</span>}
                        {h.is_offer && <span className="text-[var(--text-gold)] text-[10px] font-semibold">OFFER</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {store && (
          <div className="mb-3">
            {skus.filter(sk => !selectedSkuIds.includes(sk.id)).map(sk => (
              <button key={sk.id} onClick={() => setSelectedSkuIds(ids => [...ids, sk.id])}
                className="w-full text-left bg-[var(--bg-input)]/40 hover:bg-[var(--bg-input)] rounded-xl px-4 py-3 mb-1.5 text-[var(--text-muted2)] text-sm transition-colors flex items-center gap-2">
                <span className="text-[var(--accent)] text-lg leading-none">+</span> {sk.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {store && (
        <div className="relative p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-[var(--bg-input)]/60 shrink-0 flex gap-2 bg-[var(--bg-root)]/80 backdrop-blur-xl">
          <button onClick={() => { setStore(null); setQuery('') }}
            className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3">Change store</button>
          <div className="flex flex-col justify-center shrink-0 mr-1">
            <span className="text-[var(--text-muted2)] text-[10px] leading-tight">Invoice</span>
            <span className="text-[var(--text-primary)] font-semibold text-sm leading-tight">
              ₹{selectedSkuIds.reduce((sum, skuId) => {
                const sk = skus.find(s => s.id === skuId) || {id: skuId}
                // eslint-disable-next-line no-unused-vars
                const l = lines[sk.id] || {}
                const billable = Math.max(0, (Number(l.qty) || 0) - retTotal(l))
                return sum + billable * (Number(l.price) || 0)
              }, 0).toFixed(2)}
            </span>
          </div>
          {saveError && <p className="absolute -top-6 left-4 right-4 text-red-400 text-xs">{saveError}</p>}
          <button onClick={save} disabled={saving || !anything}
            className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors">
            {saving ? <Loader2 size={16} className="animate-spin" /> : (
                Object.values(lines).some(l => Number(l?.qty) > 0)
                  ? 'Record delivery'
                  : 'Record visit'
              )}
          </button>
        </div>
      )}
    </div>
  )
}
