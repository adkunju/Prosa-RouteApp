import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import StoreMap from './StoreMap'
import { ArrowUp, ArrowDown, Minus, X, Clock, Navigation } from 'lucide-react'

function isoDate(d) { return d.toISOString().slice(0, 10) }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function prevMonthStart(d) { return new Date(d.getFullYear(), d.getMonth() - 1, 1) }
function sameDayLastMonth(d) {
  const target = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate())
  if (target.getMonth() !== ((d.getMonth() + 11) % 12)) return new Date(d.getFullYear(), d.getMonth(), 0)
  return target
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function Ticker({ current, previous }) {
  const diff = current - previous
  const pct = previous > 0 ? Math.round((diff / previous) * 100) : (current > 0 ? 100 : 0)
  if (diff === 0) return <span className="flex items-center gap-0.5 text-[var(--text-muted)] text-xs"><Minus size={12} /> 0%</span>
  const up = diff > 0
  return (
    <span className={`flex items-center gap-0.5 text-xs font-medium ${up ? 'text-[var(--accent)]' : 'text-red-400'}`}>
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />} {Math.abs(pct)}%
    </span>
  )
}

function LineChart({ data }) {
  const w = 280, h = 64, pad = 4
  const max = Math.max(1, ...data.map(d => d.value))
  const stepX = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0
  const points = data.map((d, i) => {
    const x = pad + i * stepX
    const y = h - pad - (d.value / max) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16">
      <polyline points={points} fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function DashboardScreen() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [stores, setStores] = useState([])
  const [depot, setDepot] = useState(null)
  const [showFullMap, setShowFullMap] = useState(false)
  const [selectedStore, setSelectedStore] = useState(null)
  const [storeDaily, setStoreDaily] = useState([])
  const [storeMonthTotal, setStoreMonthTotal] = useState(0)
  const [storeLastMonthTotal, setStoreLastMonthTotal] = useState(0)
  const [storeDistanceKm, setStoreDistanceKm] = useState(null)
  const [storeHoursToday, setStoreHoursToday] = useState(null)


  async function load() {
    setLoading(true)
    const now = new Date()
    const mStart = isoDate(monthStart(now))
    const pmStart = isoDate(prevMonthStart(now))
    const pmCutoff = isoDate(sameDayLastMonth(now))
    const today = isoDate(now)

    const [{ data: dls }, { data: rets }, { data: allStores }, { data: depotRow }] = await Promise.all([
      supabase.from('delivery_lines').select('qty_delivered, delivered_on, plan_stop_id, plan_stops(store_id)'),
      supabase.from('returns').select('qty_returned, returned_on'),
      supabase.from('stores').select('id, name, lat, lng, is_depot, is_active, service_minutes, opening_hours').eq('is_active', true),
      supabase.from('stores').select('id, lat, lng').eq('is_depot', true).maybeSingle(),
    ])

    setStores(allStores || [])
    setDepot(depotRow)

    const sumDelivered = (from, to) => (dls || []).filter(d => d.delivered_on >= from && d.delivered_on <= to).reduce((a, d) => a + d.qty_delivered, 0)
    const sumReturned = (from, to) => (rets || []).filter(r => r.returned_on >= from && r.returned_on <= to).reduce((a, r) => a + r.qty_returned, 0)
    const netSold = (from, to) => sumDelivered(from, to) - sumReturned(from, to)
    const activeStores = (from, to) => new Set((dls || []).filter(d => d.delivered_on >= from && d.delivered_on <= to).map(d => d.plan_stops?.store_id)).size

    setStats({
      monthToDate: netSold(mStart, today),
      lastMonthToDate: netSold(pmStart, pmCutoff),
      activeThisMonth: activeStores(mStart, today),
      activeLastMonth: activeStores(pmStart, pmCutoff),
    })
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function openStoreDetail(store) {
    setSelectedStore(store)
    const now = new Date()
    const mStart = isoDate(monthStart(now))
    const pmStart = isoDate(prevMonthStart(now))
    const pmCutoff = isoDate(sameDayLastMonth(now))
    const today = isoDate(now)

    const { data: dlsThis } = await supabase
      .from('delivery_lines').select('qty_delivered, delivered_on, plan_stops!inner(store_id)')
      .eq('plan_stops.store_id', store.id).gte('delivered_on', mStart).lte('delivered_on', today)
    const { data: retsThis } = await supabase
      .from('returns').select('qty_returned, returned_on, delivery_lines!inner(plan_stop_id, plan_stops!inner(store_id))')
      .eq('delivery_lines.plan_stops.store_id', store.id).gte('returned_on', mStart).lte('returned_on', today)

    const { data: dlsLast } = await supabase
      .from('delivery_lines').select('qty_delivered, delivered_on, plan_stops!inner(store_id)')
      .eq('plan_stops.store_id', store.id).gte('delivered_on', pmStart).lte('delivered_on', pmCutoff)
    const { data: retsLast } = await supabase
      .from('returns').select('qty_returned, returned_on, delivery_lines!inner(plan_stop_id, plan_stops!inner(store_id))')
      .eq('delivery_lines.plan_stops.store_id', store.id).gte('returned_on', pmStart).lte('returned_on', pmCutoff)

    const byDay = {}
    ;(dlsThis || []).forEach(d => { byDay[d.delivered_on] = (byDay[d.delivered_on] || 0) + d.qty_delivered })
    ;(retsThis || []).forEach(r => { byDay[r.returned_on] = (byDay[r.returned_on] || 0) - r.qty_returned })

    const days = []
    let cursor = new Date(mStart)
    const end = new Date(today)
    while (cursor <= end) {
      const key = isoDate(cursor)
      days.push({ date: key, value: Math.max(0, byDay[key] || 0) })
      cursor = addDays(cursor, 1)
    }
    setStoreDaily(days)
    const thisTotal = days.reduce((a, d) => a + d.value, 0)
    setStoreMonthTotal(thisTotal)

    const lastDelivered = (dlsLast || []).reduce((a, d) => a + d.qty_delivered, 0)
    const lastReturned = (retsLast || []).reduce((a, r) => a + r.qty_returned, 0)
    setStoreLastMonthTotal(Math.max(0, lastDelivered - lastReturned))

    // Distance from depot via travel_matrix
    if (depot) {
      const { data: tm } = await supabase.from('travel_matrix')
        .select('meters').eq('from_store_id', depot.id).eq('to_store_id', store.id).maybeSingle()
      setStoreDistanceKm(tm ? (tm.meters / 1000).toFixed(1) : null)
    }

    // Opening hours today
    const todayName = WEEKDAYS[new Date().getDay()]
    const descs = store.opening_hours?.weekdayDescriptions
    if (Array.isArray(descs)) {
      const line = descs.find(d => d.startsWith(todayName))
      setStoreHoursToday(line || null)
    } else {
      setStoreHoursToday(null)
    }
  }

  if (loading || !stats) {
    return <div className="flex-1 flex items-center justify-center text-[var(--text-muted2)]">Loading dashboard...</div>
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-4">
      <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
        <div className="text-[var(--text-muted)] text-xs mb-1">Sales this month</div>
        <div className="flex items-end justify-between gap-2">
          <div className="text-[var(--text-primary)] text-3xl font-bold">{stats.monthToDate} <span className="text-sm text-[var(--text-muted2)] font-normal">pcs</span></div>
          <Ticker current={stats.monthToDate} previous={stats.lastMonthToDate} />
        </div>
      </div>

      <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
        <div className="text-[var(--text-muted)] text-xs mb-1">Active stores this month</div>
        <div className="flex items-end justify-between gap-2">
          <div className="text-[var(--text-primary)] text-3xl font-bold">{stats.activeThisMonth} <span className="text-sm text-[var(--text-muted2)] font-normal">stores</span></div>
          <Ticker current={stats.activeThisMonth} previous={stats.activeLastMonth} />
        </div>
      </div>

      <button onClick={() => setShowFullMap(true)}
        className="relative h-40 rounded-2xl overflow-hidden bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50">
        <div className="w-full h-full pointer-events-none">{depot && <StoreMap depot={depot} stores={stores} interactive={false} zoom={10} />}</div>
        <span className="absolute bottom-2 right-2 bg-[var(--bg-root)]/70 backdrop-blur-md text-[var(--text-secondary)] text-xs px-2 py-1 rounded-full">Tap to view map</span>
        <span className="absolute top-2 left-2 bg-[var(--bg-root)]/70 backdrop-blur-md text-[var(--text-secondary)] text-xs px-2 py-1 rounded-full">{stores.length} stores</span>
      </button>

      {showFullMap && (
        <div className="fixed inset-0 z-[45] bg-[var(--bg-root)] flex flex-col pb-20">
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0 bg-[var(--bg-card)]/80 backdrop-blur-xl">
            <span className="text-[var(--text-primary)] font-semibold">Stores</span>
            <button onClick={() => { setShowFullMap(false); setSelectedStore(null) }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex-1 relative">
            <div className="absolute inset-0">{depot && <StoreMap depot={depot} stores={stores} interactive={true} zoom={11} onStoreClick={openStoreDetail} />}</div>

            {selectedStore && (
              <div className="absolute bottom-4 left-4 right-4 bg-[var(--bg-card)]/85 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 shadow-2xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-primary)] font-semibold text-sm">{selectedStore.name}</span>
                  <button onClick={() => setSelectedStore(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
                </div>
                <div className="flex items-center gap-3 text-[var(--text-muted)] text-xs mb-3 flex-wrap">
                  {storeHoursToday && (
                    <span className="flex items-center gap-1"><Clock size={11} /> {storeHoursToday}</span>
                  )}
                  {storeDistanceKm && (
                    <span className="flex items-center gap-1"><Navigation size={11} /> {storeDistanceKm} km from depot</span>
                  )}
                </div>
                <div className="flex items-end justify-between mb-2">
                  <div className="text-[var(--text-primary)] text-xl font-bold">{storeMonthTotal} <span className="text-xs text-[var(--text-muted2)] font-normal">pcs this month</span></div>
                  <Ticker current={storeMonthTotal} previous={storeLastMonthTotal} />
                </div>
                {storeDaily.length > 1 && <LineChart data={storeDaily} />}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
