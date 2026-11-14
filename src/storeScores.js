import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { localISO } from './dbUtils'

// Profit score per store, from the last WINDOW_DAYS of deliveries.
//
//   paid pcs   = delivered − expired (sale-or-return: expired pieces aren't paid for)
//   profit     = paid pcs × the price on each delivery − delivered pcs × making cost
//   per visit  = profit ÷ number of delivery days
//   score      = 0–100: where the store's profit per visit ranks among all stores
//                (100 = best). A store that loses money on average scores low.
//
// Expired pieces are typed in at the next visit, so the most recent delivery may not have
// its expiry yet; stores with only 1 visit are marked as early data.
export const WINDOW_DAYS = 60
const PAGE = 1000

let cache = null      // { at, data } for this session
let inflight = null

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

async function load() {
  const since = new Date(); since.setDate(since.getDate() - WINDOW_DAYS)
  const sinceISO = localISO(since)
  const [lines, rets, skus, fc] = await Promise.all([
    fetchAll(() => supabase.from('delivery_lines').select('id, store_id, sku_id, qty_delivered, unit_price, delivered_on')
      .gte('delivered_on', sinceISO).order('id')),
    fetchAll(() => supabase.from('returns').select('delivery_line_id, qty_returned')
      .gte('returned_on', sinceISO).order('id')),
    supabase.from('skus').select('id, unit_cost, unit_price').then(r => r.data || []),
    supabase.from('store_sku_forecast').select('store_id, last_visit_date').then(r => r.data || []),
  ])
  const cost = Object.fromEntries(skus.map(s => [s.id, Number(s.unit_cost) || 0]))
  const listPrice = Object.fromEntries(skus.map(s => [s.id, Number(s.unit_price) || 0]))
  const expiredByLine = {}
  rets.forEach(r => { if (r.delivery_line_id) expiredByLine[r.delivery_line_id] = (expiredByLine[r.delivery_line_id] || 0) + (r.qty_returned || 0) })

  const by = {}
  lines.forEach(l => {
    const s = by[l.store_id] ||= { delivered: 0, expired: 0, revenue: 0, cogs: 0, days: new Set(), last: null }
    const qty = l.qty_delivered || 0
    const exp = Math.min(qty, expiredByLine[l.id] || 0)
    const price = l.unit_price != null ? Number(l.unit_price) : (listPrice[l.sku_id] || 0)
    s.delivered += qty
    s.expired += exp
    s.revenue += (qty - exp) * price
    s.cogs += qty * (cost[l.sku_id] || 0)
    s.days.add(l.delivered_on)
    if (!s.last || l.delivered_on > s.last) s.last = l.delivered_on
  })

  const stats = {}
  Object.entries(by).forEach(([id, s]) => {
    const visits = s.days.size
    const profit = s.revenue - s.cogs
    stats[id] = {
      visits, delivered: s.delivered, expired: s.expired,
      expiryPct: s.delivered ? Math.round(s.expired / s.delivered * 100) : 0,
      profit: Math.round(profit),
      perVisit: visits ? Math.round(profit / visits) : 0,
      lastDelivered: s.last,
    }
  })
  // Rank stores on profit per visit → 0–100
  const ranked = Object.entries(stats).sort((a, b) => a[1].perVisit - b[1].perVisit)
  ranked.forEach(([, st], i) => { st.score = ranked.length > 1 ? Math.round(i / (ranked.length - 1) * 100) : 50 })

  // Last delivery date for every store (including ones with no deliveries in the window)
  const last = {}
  fc.forEach(r => { if (r.last_visit_date && (!last[r.store_id] || r.last_visit_date > last[r.store_id])) last[r.store_id] = r.last_visit_date })
  Object.entries(stats).forEach(([id, st]) => { if (st.lastDelivered && (!last[id] || st.lastDelivered > last[id])) last[id] = st.lastDelivered })

  return { stats, last }
}

export function useStoreScores() {
  const [data, setData] = useState(cache?.data || { stats: {}, last: {} })
  useEffect(() => {
    let alive = true
    const fresh = cache && Date.now() - cache.at < 10 * 60 * 1000
    if (!fresh) {
      inflight ||= load().then(d => { cache = { at: Date.now(), data: d }; return d }).finally(() => { inflight = null })
      inflight.then(d => { if (alive) setData(d) }).catch(e => console.error('store scores failed', e))
    }
    const onChange = () => { cache = null }
    window.addEventListener('prosa:stock_changed', onChange)
    return () => { alive = false; window.removeEventListener('prosa:stock_changed', onChange) }
  }, [])
  return data
}

// Colour for a score: red (0) → amber (50) → green (100)
export function scoreColor(score) {
  return `hsl(${Math.round((score ?? 0) * 1.2)} 65% 45%)`
}
