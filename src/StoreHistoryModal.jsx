import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { X } from 'lucide-react'

const fmt = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) }
const short = n => (n || 'Item').replace(/^Prosa\s+/i, '').split('/')[0].trim()

// Last visits to a store: per visit date, what was delivered and what came back, per product
export default function StoreHistoryModal({ storeId, storeName, onClose }) {
  const [visits, setVisits] = useState(null)

  useEffect(() => { (async () => {
    const [{ data: lines }, { data: rets }] = await Promise.all([
      supabase.from('delivery_lines').select('delivered_on, qty_delivered, unit_price, is_offer, skus(name)')
        .eq('store_id', storeId).order('delivered_on', { ascending: false }).limit(120),
      supabase.from('returns').select('returned_on, qty_returned, skus(name)')
        .eq('store_id', storeId).order('returned_on', { ascending: false }).limit(120),
    ])
    const byDate = {}
    const get = d => (byDate[d] = byDate[d] || { date: d, items: {} })
    const item = (v, n) => (v.items[n] = v.items[n] || { delivered: 0, returned: 0, price: null, offer: false })
    ;(lines || []).forEach(l => {
      const it = item(get(l.delivered_on), short(l.skus?.name))
      it.delivered += l.qty_delivered || 0
      if (l.unit_price != null) it.price = l.unit_price
      if (l.is_offer) it.offer = true
    })
    ;(rets || []).forEach(r => { item(get(r.returned_on), short(r.skus?.name)).returned += r.qty_returned || 0 })
    setVisits(Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12))
  })() }, [storeId])

  const totals = (visits || []).reduce((t, v) => {
    Object.values(v.items).forEach(i => { t.d += i.delivered; t.r += i.returned }); return t
  }, { d: 0, r: 0 })

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/50 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[var(--text-primary)] font-semibold truncate">{storeName}</div>
            <div className="text-[var(--text-muted2)] text-xs">
              Last {visits?.length || 0} visits{visits?.length ? ` · ${totals.d} delivered · ${totals.r} returned` : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {visits === null && <p className="text-[var(--text-muted2)] text-sm">Loading...</p>}
          {visits?.length === 0 && <p className="text-[var(--text-muted2)] text-sm">No deliveries yet.</p>}
          {visits?.map(v => (
            <div key={v.date} className="bg-[var(--bg-input)]/30 rounded-xl px-3 py-2">
              <div className="text-[var(--text-muted)] text-xs mb-1">{fmt(v.date)}</div>
              {Object.entries(v.items).map(([name, i]) => (
                <div key={name} className="flex items-center justify-between text-sm gap-2">
                  <span className="text-[var(--text-secondary)] truncate">{name}</span>
                  <span className="shrink-0 flex items-center gap-2">
                    {i.delivered > 0 && <span className="text-[var(--text-primary)] font-medium">{i.delivered} sent</span>}
                    {i.returned > 0 && <span className="text-[var(--text-amber)]">↩ {i.returned}</span>}
                    {i.price != null && i.delivered > 0 && <span className="text-[var(--text-muted2)] text-xs">₹{Number(i.price)}{i.offer ? ' offer' : ''}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
