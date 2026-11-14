import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabaseClient'
import { localISO } from './dbUtils'
import { useIsDesktop } from './useIsDesktop'
import { useStoreScores, scoreColor } from './storeScores'
import { Search } from 'lucide-react'

// Settings → Price List: every store's preset price per product, the margin it gives,
// and how that product actually did there over the last WINDOW days.
const WINDOW = 60
const PAGE = 1000

async function fetchAll(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

const shortSku = n => (n || '').replace(/^Prosa\s+/i, '').split('/')[0].trim()
const rs = n => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN')
const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

export default function PriceListPanel() {
  const isDesktop = useIsDesktop()
  const { stats: scoreStats } = useStoreScores()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('name') // name | margin | profit
  const [showAll, setShowAll] = useState(false) // include dropped / prospect stores

  useEffect(() => { (async () => {
    try {
      const since = new Date(); since.setDate(since.getDate() - WINDOW)
      const sinceISO = localISO(since)
      const [stores, skus, prices, lines, rets] = await Promise.all([
        supabase.from('stores').select('id, name, pipeline_status, is_d2c, is_depot').eq('is_active', true).then(r => r.data || []),
        supabase.from('skus').select('id, name, unit_cost, unit_price, is_active').then(r => r.data || []),
        supabase.from('store_sku_price_latest').select('store_id, sku_id, price, effective_from').then(r => r.data || []),
        fetchAll(() => supabase.from('delivery_lines').select('id, store_id, sku_id, qty_delivered, unit_price, is_offer, delivered_on').gte('delivered_on', sinceISO).order('id')),
        fetchAll(() => supabase.from('returns').select('delivery_line_id, qty_returned').gte('returned_on', sinceISO).order('id')),
      ])
      setData({ stores, skus, prices, lines, rets })
    } catch (e) { setErr(e.message || String(e)) }
  })() }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const sku = Object.fromEntries(data.skus.map(s => [s.id, s]))
    const activeSkus = data.skus.filter(s => s.is_active)
    const expired = {}
    data.rets.forEach(r => { if (r.delivery_line_id) expired[r.delivery_line_id] = (expired[r.delivery_line_id] || 0) + (r.qty_returned || 0) })
    // per store+product actuals over the window
    const act = {}
    data.lines.forEach(l => {
      const k = `${l.store_id}_${l.sku_id}`
      const a = act[k] ||= { delivered: 0, expired: 0, revenue: 0, paidPcs: 0, priceSum: 0, priceN: 0, offers: 0, last: null }
      const qty = l.qty_delivered || 0
      const exp = Math.min(qty, expired[l.id] || 0)
      const price = Number(l.unit_price ?? sku[l.sku_id]?.unit_price ?? 0)
      a.delivered += qty; a.expired += exp
      a.revenue += (qty - exp) * price; a.paidPcs += qty - exp
      a.priceSum += price * qty; a.priceN += qty
      if (l.is_offer) a.offers += qty
      if (!a.last || l.delivered_on > a.last) a.last = l.delivered_on
    })
    const preset = Object.fromEntries(data.prices.map(p => [`${p.store_id}_${p.sku_id}`, p]))

    return data.stores
      .filter(s => !s.is_depot && (showAll || ['onboard', 'dormant'].includes(s.pipeline_status) || !s.pipeline_status))
      .map(s => {
        const items = activeSkus.map(k => {
          const key = `${s.id}_${k.id}`
          const p = preset[key], a = act[key]
          if (!p && !a) return null
          const cost = Number(k.unit_cost) || 0
          const price = p ? Number(p.price) : null
          const list = Number(k.unit_price) || 0
          const margin = price != null ? price - cost : null
          const profit = a ? a.revenue - a.delivered * cost : null
          return {
            sku: shortSku(k.name), price, since: p?.effective_from, list, cost, margin,
            marginPct: price ? Math.round(margin / price * 100) : null,
            vsList: price != null && list ? Math.round((price - list) * 100) / 100 : null,
            delivered: a?.delivered || 0, expired: a?.expired || 0,
            expiryPct: a?.delivered ? Math.round(a.expired / a.delivered * 100) : null,
            avgPaid: a?.priceN ? a.priceSum / a.priceN : null,
            offers: a?.offers || 0,
            profit,
            perPc: a?.delivered ? profit / a.delivered : null, // after expiries
          }
        }).filter(Boolean)
        const totalProfit = items.reduce((n, i) => n + (i.profit || 0), 0)
        const bestMargin = Math.max(...items.map(i => i.marginPct ?? -999))
        return { id: s.id, name: s.name, status: s.pipeline_status, items, totalProfit, bestMargin }
      })
      .filter(s => s.items.length > 0)
      .filter(s => !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => sort === 'profit' ? b.totalProfit - a.totalProfit
        : sort === 'margin' ? b.bestMargin - a.bestMargin
        : a.name.localeCompare(b.name))
  }, [data, q, sort, showAll])

  // summary across the list
  const summary = useMemo(() => {
    const all = rows.flatMap(r => r.items)
    const priced = all.filter(i => i.price != null)
    const avgMargin = priced.length ? Math.round(priced.reduce((n, i) => n + i.marginPct, 0) / priced.length) : null
    const delivered = all.reduce((n, i) => n + i.delivered, 0)
    const expiredN = all.reduce((n, i) => n + i.expired, 0)
    return {
      stores: rows.length, avgMargin, delivered,
      expiryPct: delivered ? Math.round(expiredN / delivered * 100) : 0,
      profit: Math.round(all.reduce((n, i) => n + (i.profit || 0), 0)),
      noPrice: all.filter(i => i.price == null).length,
    }
  }, [rows])

  if (err) return <p className="text-red-400 text-sm">Could not load the price list: {err}</p>
  if (!data) return <p className="text-[var(--text-muted2)] text-sm">Loading price list…</p>

  const marginTone = pct => pct == null ? 'text-[var(--text-muted2)]' : pct >= 40 ? 'text-[var(--accent)]' : pct >= 25 ? 'text-[var(--text-gold)]' : 'text-red-400'
  const expTone = pct => pct == null ? 'text-[var(--text-muted2)]' : pct >= 20 ? 'text-red-400' : pct >= 10 ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted)]'
  const badge = id => {
    const st = scoreStats[id]
    return st ? <span className="text-[10px] font-bold text-white rounded-full px-1.5 py-0.5 tabular-nums" style={{ background: scoreColor(st.score) }} title="Profit score (0–100)">{st.score}</span> : null
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[
          ['Stores', summary.stores],
          ['Avg margin on price list', summary.avgMargin != null ? `${summary.avgMargin}%` : '—'],
          [`Expired (last ${WINDOW} days)`, `${summary.expiryPct}% of ${summary.delivered} pcs`],
          [`Profit (last ${WINDOW} days)`, rs(summary.profit)],
        ].map(([label, val]) => (
          <div key={label} className="bg-[var(--bg-card)]/60 border border-[var(--bg-input)]/50 rounded-xl px-3 py-2">
            <div className="text-[var(--text-muted2)] text-[11px]">{label}</div>
            <div className="text-[var(--text-primary)] text-base font-semibold">{val}</div>
          </div>
        ))}
      </div>
      {summary.noPrice > 0 && (
        <p className="text-[var(--text-gold)] text-xs">{summary.noPrice} product line{summary.noPrice > 1 ? 's have' : ' has'} deliveries but no preset price ("—").</p>
      )}

      {/* Search + sort */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stores…"
            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
        </div>
        <select value={sort} onChange={e => setSort(e.target.value)}
          className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2 text-sm outline-none">
          <option value="name">Sort: A–Z</option>
          <option value="margin">Sort: highest margin</option>
          <option value="profit">Sort: most profit</option>
        </select>
        <label className="flex items-center gap-1.5 text-[var(--text-muted)] text-xs">
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Include dropped &amp; prospects
        </label>
      </div>
      <p className="text-[var(--text-muted2)] text-[11px] -mt-1">
        Margin = preset price − making cost. Profit counts expired pieces as unpaid and their cost as lost. Sales figures are the last {WINDOW} days.
      </p>

      {isDesktop ? (
        <div className="overflow-x-auto rounded-xl border border-[var(--bg-input)]/60">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-card)] text-[var(--text-muted2)] text-left">
              <tr>
                {['Store', 'Product', 'Price', 'vs list', 'Margin', 'Delivered', 'Expired', 'Avg paid', 'Profit', '/pc', 'Price since'].map(h => (
                  <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${h === 'Store' || h === 'Product' ? '' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(s => s.items.map((i, j) => (
                <tr key={s.id + i.sku} className={`${j === 0 ? 'border-t border-[var(--bg-input)]/70' : ''} hover:bg-[var(--bg-card)]/50`}>
                  <td className="px-3 py-1.5 align-top">
                    {j === 0 && <div className="flex items-center gap-1.5"><span className="text-[var(--text-primary)] font-medium">{s.name}</span>{badge(s.id)}{s.status && s.status !== 'onboard' && <span className="text-[10px] text-[var(--text-muted2)]">{s.status}</span>}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{i.sku}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-primary)] font-semibold tabular-nums">{i.price != null ? rs(i.price) : '—'}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${i.vsList == null ? 'text-[var(--text-muted2)]' : i.vsList < 0 ? 'text-red-400' : i.vsList > 0 ? 'text-[var(--accent)]' : 'text-[var(--text-muted2)]'}`}>
                    {i.vsList == null ? '—' : i.vsList === 0 ? 'same' : `${i.vsList > 0 ? '+' : '−'}${rs(Math.abs(i.vsList))}`}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${marginTone(i.marginPct)}`}>{i.margin != null ? `${rs(i.margin)} · ${i.marginPct}%` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{i.delivered || '—'}{i.offers ? <span className="text-[var(--text-gold)]" title="pieces sold at offer price"> ({i.offers} offer)</span> : ''}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${expTone(i.expiryPct)}`}>{i.delivered ? `${i.expired} · ${i.expiryPct}%` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{i.avgPaid != null ? rs(i.avgPaid) : '—'}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${i.profit == null ? 'text-[var(--text-muted2)]' : i.profit < 0 ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>{i.profit != null ? rs(Math.round(i.profit)) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--text-muted)]">{i.perPc != null ? rs(i.perPc) : '—'}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-muted2)] whitespace-nowrap">{fmtDate(i.since)}</td>
                </tr>
              )))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="text-[var(--text-muted2)] text-sm text-center py-6">No stores match.</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(s => (
            <div key={s.id} className="bg-[var(--bg-card)] rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{s.name}</span>
                {badge(s.id)}
                <span className="flex-1" />
                <span className={`text-xs font-medium ${s.totalProfit < 0 ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>{rs(Math.round(s.totalProfit))}</span>
              </div>
              {s.items.map(i => (
                <div key={i.sku} className="border-t border-[var(--bg-input)]/40 py-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-[var(--text-secondary)]">{i.sku}</span>
                    <span className="text-[var(--text-primary)] font-semibold">{i.price != null ? rs(i.price) : '—'}</span>
                    <span className={`text-xs ${marginTone(i.marginPct)}`}>{i.margin != null ? `margin ${rs(i.margin)} · ${i.marginPct}%` : 'no preset price'}</span>
                  </div>
                  <div className="text-[var(--text-muted2)] text-xs mt-0.5">
                    {i.delivered ? <>
                      {i.delivered} pcs · <span className={expTone(i.expiryPct)}>{i.expired} expired ({i.expiryPct}%)</span>
                      {i.avgPaid != null && <> · avg paid {rs(i.avgPaid)}</>}
                      {i.offers ? <span className="text-[var(--text-gold)]"> · {i.offers} at offer</span> : null}
                    </> : <>No deliveries in the last {WINDOW} days</>}
                    {i.since && <> · price since {fmtDate(i.since)}</>}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {rows.length === 0 && <p className="text-[var(--text-muted2)] text-sm text-center py-6">No stores match.</p>}
        </div>
      )}
    </div>
  )
}
