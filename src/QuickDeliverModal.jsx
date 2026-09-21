import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
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

export default function QuickDeliverModal({ onClose, onSaved }) {
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

  useEffect(() => { (async () => {
    const [{ data: st }, { data: sk }, { data: b }, { data: dl }, { data: rdl }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name, unit_price').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').order('produced_on'),
      supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
      supabase.from('delivery_lines').select('store_id, delivered_on').order('delivered_on', { ascending: false }).limit(60),
    ])
    const used = {}
    ;(dl || []).forEach(d => { used[d.batch_id] = (used[d.batch_id] || 0) + d.qty_delivered })
    const seen = new Set()
    const recent = []
    ;(rdl||[]).forEach(x => { if (!seen.has(x.store_id)) { seen.add(x.store_id); recent.push(x.store_id) } })
    setRecentIds(recent)
    setStores(st || [])
    setSkus(sk || [])
    setBatches((b || []).map(x => ({ ...x, available: x.qty - (used[x.id] || 0) })))
  })() }, [])

  const recentStores = recentIds.slice(0, 8).map(id => stores.find(s => s.id === id)).filter(Boolean)
  const matches = query.trim()
    ? stores.filter(s => _tokenMatch(query, s.name)).slice(0, 8)
    : recentStores

  function batchesFor(skuId) {
    return batches.filter(b => b.sku_id === skuId && b.available > 0 && b.expires_on >= today())
  }

  function setLine(skuId, patch) {
    setLines(l => ({ ...l, [skuId]: { ...l[skuId], ...patch } }))
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
      init[sk.id] = { qty: '', batch_id: batchesFor(sk.id)[0]?.id || '', returned: '', produced_on: '', price, is_offer: false, store_balance: '' }
    })
    setRemark('')
    setLines(init)
    setSelectedSkuIds([])

    // Fetch delivery history for this store
    const [{ data: hist }, { data: rets }] = await Promise.all([
      supabase.from('delivery_lines')
        .select('id, sku_id, qty_delivered, delivered_on, unit_price, is_offer')
        .eq('store_id', s.id)
        .order('delivered_on', { ascending: false })
        .limit(40),
      supabase.from('returns')
        .select('delivery_line_id, qty_returned')
        .eq('store_id', s.id),
    ])
    const retsByLine = {}
    ;(rets || []).forEach(r => {
      if (r.delivery_line_id) retsByLine[r.delivery_line_id] = (retsByLine[r.delivery_line_id] || 0) + r.qty_returned
    })
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
    if (!store) return
    setSaving(true)
    const dateStr = today()
    for (const skuId of selectedSkuIds) {
      const sk = skus.find(s => s.id === skuId)
      if (!sk) continue
      const l = lines[sk.id] || {}
      const qty = Number(l.qty) || 0
      const ret = Number(l.returned) || 0
      if (qty <= 0 && ret <= 0) continue

      let lineId = null
      if (qty > 0) {
        const { data } = await supabase.from('delivery_lines').insert({
          store_id: store.id,
          plan_stop_id: null,
          sku_id: sk.id,
          batch_id: l.batch_id || null,
          qty_delivered: qty,
          unit_price: l.price === '' ? null : Number(l.price),
          is_offer: l.is_offer || false,
          store_balance: l.store_balance !== '' && l.store_balance !== undefined ? Number(l.store_balance) : null,
          delivered_on: dateStr,
        }).select('id').single()
        lineId = data?.id || null
      }
      if (ret > 0) {
        const { error: retErr } = await supabase.from('returns').insert({
          delivery_line_id: lineId || null,
          store_id: store.id,
          sku_id: sk.id,
          produced_on: l.produced_on || null,
          qty_returned: ret,
          returned_on: dateStr,
          possible_stockout: false,
          reason: 'Unplanned visit',
        })
        if (retErr) console.error('Return insert failed:', retErr.message)
      }
    }
    // If visit-only (no delivery) save remark to call_logs via plan_stops is not applicable
    // Record as a store note instead using a simple insert
    if (remark.trim() && !Object.values(lines).some(l => Number(l?.qty) > 0)) {
      // Pure visit — log to call_logs against first contact
      const { data: contacts } = await supabase.from('store_contacts').select('id').eq('store_id', store.id).limit(1)
      if (contacts?.[0]) {
        await supabase.from('call_logs').insert({
          store_contact_id: contacts[0].id,
          note: remark.trim(),
          called_at: new Date().toISOString(),
        })
      }
    }
    setSaving(false)
    onSaved?.()
    onClose?.()
  }

  const anything = remark.trim().length > 0 || selectedSkuIds.some(id => Number(lines[id]?.qty) > 0 || Number(lines[id]?.returned) > 0)

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
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Returned</label>
                  <input type="number" min="0" placeholder="0" value={l.returned ?? ''}
                    onChange={e => setLine(sk.id, { returned: e.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              </div>
              {(Number(l.qty) > 0 || Number(l.returned) > 0) && (
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
                    Billed {Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0))} pcs
                    {l.price !== '' && ` · ₹${(Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0)) * Number(l.price)).toFixed(2)}`}
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
              {Number(l.returned) > 0 && (
                <div>
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Production date on returned pack</label>
                  <input type="date" max={today()} value={l.produced_on || ''}
                    onChange={e => setLine(sk.id, { produced_on: e.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              )}
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
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-[var(--bg-input)]/60 shrink-0 flex gap-2 bg-[var(--bg-root)]/80 backdrop-blur-xl">
          <button onClick={() => { setStore(null); setQuery('') }}
            className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3">Change store</button>
          <div className="flex flex-col justify-center shrink-0 mr-1">
            <span className="text-[var(--text-muted2)] text-[10px] leading-tight">Invoice</span>
            <span className="text-[var(--text-primary)] font-semibold text-sm leading-tight">
              ₹{selectedSkuIds.reduce((sum, skuId) => {
                const sk = skus.find(s => s.id === skuId) || {id: skuId}
                // eslint-disable-next-line no-unused-vars
                const l = lines[sk.id] || {}
                const billable = Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0))
                return sum + billable * (Number(l.price) || 0)
              }, 0).toFixed(2)}
            </span>
          </div>
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
