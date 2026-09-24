import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { X } from 'lucide-react'

const fmt = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }
const short = n => (n || 'Item').replace(/^Prosa\s+/i, '')

// Store history grouped by product: totals on top, then a one-line-per-visit timeline
// (last 90 days). Returns are shown on the visit they were picked up.
export default function StoreHistoryModal({ storeId, storeName, onClose }) {
  const [skus, setSkus] = useState(null)

  useEffect(() => { (async () => {
    const since = new Date(); since.setDate(since.getDate() - 90)
    const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`
    const [{ data: lines }, { data: rets }] = await Promise.all([
      supabase.from('delivery_lines').select('delivered_on, qty_delivered, unit_price, sku_id, skus(name)')
        .eq('store_id', storeId).gte('delivered_on', from),
      supabase.from('returns').select('returned_on, qty_returned, sku_id, skus(name)')
        .eq('store_id', storeId).gte('returned_on', from),
    ])
    const bySku = {}
    const sku = (id, name) => (bySku[id] = bySku[id] || { name: short(name), visits: {}, sent: 0, back: 0, price: null })
    const visit = (s, d) => (s.visits[d] = s.visits[d] || { date: d, sent: 0, back: 0 })
    ;(lines || []).forEach(l => {
      const s = sku(l.sku_id, l.skus?.name)
      visit(s, l.delivered_on).sent += l.qty_delivered || 0
      s.sent += l.qty_delivered || 0
      if (l.unit_price != null) s.price = l.unit_price
    })
    ;(rets || []).forEach(r => {
      const s = sku(r.sku_id, r.skus?.name)
      visit(s, r.returned_on).back += r.qty_returned || 0
      s.back += r.qty_returned || 0
    })
    setSkus(Object.values(bySku).map(s => ({
      ...s,
      list: Object.values(s.visits).sort((a, b) => b.date.localeCompare(a.date)),
      max: Math.max(1, ...Object.values(s.visits).map(v => Math.max(v.sent, v.back))),
    })).sort((a, b) => b.sent - a.sent))
  })() }, [storeId])

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/50 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[var(--text-primary)] font-semibold truncate">{storeName}</div>
            <div className="text-[var(--text-muted2)] text-xs">Last 90 days</div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {skus === null && <p className="text-[var(--text-muted2)] text-sm">Loading...</p>}
          {skus?.length === 0 && <p className="text-[var(--text-muted2)] text-sm">No deliveries in the last 90 days.</p>}
          {skus?.map(s => {
            const sold = s.sent - s.back
            const pct = s.sent ? Math.round((sold / s.sent) * 100) : 0
            return (
              <div key={s.name}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{s.name}</span>
                  {s.price != null && <span className="text-[var(--text-muted2)] text-xs shrink-0">₹{Number(s.price)}</span>}
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  {[['Sent', s.sent, 'text-[var(--text-primary)]'], ['Returned', s.back, 'text-[var(--text-amber)]'], ['Sold', `${sold} · ${pct}%`, pct < 70 ? 'text-red-400' : 'text-[var(--accent)]']].map(([l, v, c]) => (
                    <div key={l} className="bg-[var(--bg-input)]/40 rounded-lg px-2 py-1.5">
                      <div className="text-[var(--text-muted2)] text-[10px] uppercase tracking-wide">{l}</div>
                      <div className={`text-sm font-semibold ${c}`}>{v}</div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col">
                  {s.list.map(v => (
                    <div key={v.date} className="flex items-center gap-2 py-1 text-xs border-l-2 border-[var(--bg-input)] pl-2">
                      <span className="w-12 shrink-0 text-[var(--text-muted)]">{fmt(v.date)}</span>
                      <span className="flex-1 flex items-center gap-0.5 h-2">
                        <span className="h-2 rounded-sm bg-[var(--accent)]/70" style={{ width: `${(v.sent / s.max) * 60}%` }} />
                        <span className="h-2 rounded-sm bg-[var(--text-amber)]/70" style={{ width: `${(v.back / s.max) * 60}%` }} />
                      </span>
                      <span className="w-20 shrink-0 text-right">
                        {v.sent > 0 && <span className="text-[var(--text-primary)]">{v.sent}</span>}
                        {v.back > 0 && <span className="text-[var(--text-amber)]"> ↩{v.back}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
