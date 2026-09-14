import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { X, Search, Loader2 } from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)

export default function QuickDeliverModal({ onClose, onSaved }) {
  const [stores, setStores] = useState([])
  const [skus, setSkus] = useState([])
  const [batches, setBatches] = useState([])
  const [query, setQuery] = useState('')
  const [store, setStore] = useState(null)
  const [lines, setLines] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { (async () => {
    const [{ data: st }, { data: sk }, { data: b }, { data: dl }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name, unit_price').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').order('produced_on'),
      supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
    ])
    const used = {}
    ;(dl || []).forEach(d => { used[d.batch_id] = (used[d.batch_id] || 0) + d.qty_delivered })
    setStores(st || [])
    setSkus(sk || [])
    setBatches((b || []).map(x => ({ ...x, available: x.qty - (used[x.id] || 0) })))
  })() }, [])

  const matches = query.trim()
    ? stores.filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : []

  function batchesFor(skuId) {
    return batches.filter(b => b.sku_id === skuId && b.available > 0 && b.expires_on >= today())
  }

  function setLine(skuId, patch) {
    setLines(l => ({ ...l, [skuId]: { ...l[skuId], ...patch } }))
  }

  function pickStore(s) {
    setStore(s)
    const init = {}
    skus.forEach(sk => {
      init[sk.id] = { qty: '', batch_id: batchesFor(sk.id)[0]?.id || '', returned: '', produced_on: '', price: sk.unit_price ?? '' }
    })
    setLines(init)
  }

  async function save() {
    if (!store) return
    setSaving(true)
    const dateStr = today()
    for (const sk of skus) {
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
          delivered_on: dateStr,
        }).select('id').single()
        lineId = data?.id || null
      }
      if (ret > 0) {
        await supabase.from('returns').insert({
          delivery_line_id: null,
          store_id: store.id,
          sku_id: sk.id,
          produced_on: l.produced_on || null,
          qty_returned: ret,
          returned_on: dateStr,
          possible_stockout: false,
          reason: 'Unplanned visit',
        })
      }
    }
    setSaving(false)
    onSaved?.()
    onClose?.()
  }

  const anything = Object.values(lines).some(l => Number(l?.qty) > 0 || Number(l?.returned) > 0)

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
            {query && matches.length === 0 && (
              <p className="text-[var(--text-muted2)] text-sm text-center mt-6">No store matches that</p>
            )}
          </>
        )}

        {store && skus.map(sk => {
          const l = lines[sk.id] || {}
          const avail = batchesFor(sk.id)
          return (
            <div key={sk.id} className="bg-[var(--bg-card)]/80 border border-[var(--bg-input)]/40 rounded-xl p-4 mb-3">
              <div className="text-[var(--text-primary)] text-sm font-medium mb-3">{sk.name}</div>
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
                  <label className="text-[var(--text-muted)] text-xs mb-1 block">Price per pc (₹)</label>
                  <input type="number" min="0" step="0.01" value={l.price ?? ''}
                    onChange={ev => setLine(sk.id, { price: ev.target.value })}
                    className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                  <p className="text-[var(--text-muted2)] text-xs mt-1">
                    Billed {Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0))} pcs
                    {l.price !== '' && ` · ₹${(Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0)) * Number(l.price)).toFixed(2)}`}
                  </p>
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
            </div>
          )
        })}
      </div>

      {store && (
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-[var(--bg-input)]/60 shrink-0 flex gap-2 bg-[var(--bg-root)]/80 backdrop-blur-xl">
          <button onClick={() => { setStore(null); setQuery('') }}
            className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3">Change store</button>
          <div className="flex flex-col justify-center shrink-0 mr-1">
            <span className="text-[var(--text-muted2)] text-[10px] leading-tight">Invoice</span>
            <span className="text-[var(--text-primary)] font-semibold text-sm leading-tight">
              ₹{skus.reduce((sum, sk) => {
                const l = lines[sk.id] || {}
                const billable = Math.max(0, (Number(l.qty) || 0) - (Number(l.returned) || 0))
                return sum + billable * (Number(l.price) || 0)
              }, 0).toFixed(2)}
            </span>
          </div>
          <button onClick={save} disabled={saving || !anything}
            className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors">
            {saving ? <Loader2 size={16} className="animate-spin" /> : 'Record delivery'}
          </button>
        </div>
      )}
    </div>
  )
}
