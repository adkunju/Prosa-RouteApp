import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import StoreMap from './StoreMap'
import QuickDeliverModal from './QuickDeliverModal'
import AddStoreModal from './AddStoreModal'
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
  const [quickOpen, setQuickOpen] = useState(false)
  const [addStoreOpen, setAddStoreOpen] = useState(false)
  const [stock, setStock] = useState([])
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
      .from('delivery_lines').select('id, qty_delivered, delivered_on, plan_stops!inner(store_id)')
      .eq('plan_stops.store_id', store.id).gte('delivered_on', mStart).lte('delivered_on', today)
    const { data: retsThis } = await supabase
      .from('returns').select('qty_returned, returned_on, delivery_line_id, delivery_lines!inner(plan_stop_id, plan_stops!inner(store_id))')
      .eq('delivery_lines.plan_stops.store_id', store.id).gte('returned_on', mStart).lte('returned_on', today)

    const { data: dlsLast } = await supabase
      .from('delivery_lines').select('id, qty_delivered, delivered_on, plan_stops!inner(store_id)')
      .eq('plan_stops.store_id', store.id).gte('delivered_on', pmStart).lte('delivered_on', pmCutoff)
    const { data: retsLast } = await supabase
      .from('returns').select('qty_returned, returned_on, delivery_line_id, delivery_lines!inner(plan_stop_id, plan_stops!inner(store_id))')
      .eq('delivery_lines.plan_stops.store_id', store.id).gte('returned_on', pmStart).lte('returned_on', pmCutoff)

    // Per-visit aggregation: one point per delivery date, returns attributed
    // back to the delivery they came from (not the day they were collected).
    const lineToDate = {}
    ;(dlsThis || []).forEach(d => { lineToDate[d.id] = d.delivered_on })

    const byVisit = {}
    ;(dlsThis || []).forEach(d => {
      byVisit[d.delivered_on] = (byVisit[d.delivered_on] || 0) + d.qty_delivered
    })
    ;(retsThis || []).forEach(r => {
      const visitDate = lineToDate[r.delivery_line_id]
      if (visitDate) byVisit[visitDate] = (byVisit[visitDate] || 0) - r.qty_returned
    })

    const visits = Object.keys(byVisit).sort().map(date => ({ date, value: byVisit[date] }))
    setStoreDaily(visits)
    setStoreMonthTotal(visits.reduce((a, v) => a + v.value, 0))

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

  useEffect(() => { (async () => {
    const [{ data: b }, { data: dl }] = await Promise.all([
      supabase.from('production_batches').select('id, sku_id, qty, produced_on, expires_on, is_spare, skus(name)').order('expires_on'),
      supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
    ])
    const used = {}
    ;(dl || []).forEach(x => { used[x.batch_id] = (used[x.batch_id] || 0) + x.qty_delivered })
    const today = new Date().toISOString().slice(0, 10)
    const allBatches = (b || [])
      .map(x => ({ ...x, available: x.qty - (used[x.id] || 0) }))
      .filter(x => x.available > 0 && x.expires_on >= today)
    setStock(allBatches)
  })() }, [])

  const [selectedDate, setSelectedDate] = useState(new Date().toLocaleDateString('en-CA'))
  const [showAllDeliveries, setShowAllDeliveries] = useState(false)
  const [deliveriesToday, setDeliveriesToday] = useState([])
  useEffect(() => { (async () => {
    const [{ data: dl }, { data: rt }] = await Promise.all([
      supabase.from('delivery_lines')
        .select('qty_delivered, stores(name)')
        .eq('delivered_on', selectedDate)
        .gt('qty_delivered', 0),
      supabase.from('returns')
        .select('qty_returned, stores(name)')
        .eq('returned_on', selectedDate)
        .gt('qty_returned', 0),
    ])
    const byStore = {}
    ;(dl || []).forEach(d => {
      const name = d.stores?.name || 'Unknown'
      if (!byStore[name]) byStore[name] = { qty: 0, ret: 0 }
      byStore[name].qty += Number(d.qty_delivered) || 0
    })
    ;(rt || []).forEach(r => {
      if (!r.stores?.name) return
      const name = r.stores.name
      if (!byStore[name]) byStore[name] = { qty: 0, ret: 0 }
      byStore[name].ret += Number(r.qty_returned) || 0
    })
    setDeliveriesToday(Object.entries(byStore).map(([name, v]) => ({ name, qty: v.qty, ret: v.ret })).sort((a, b) => b.qty - a.qty))
  })() }, [selectedDate])

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

      <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[var(--text-muted)] text-xs">Stock in hand</span>
          <span className="text-[var(--text-muted2)] text-xs">{stock.filter(b => !b.is_spare).length} batch{stock.filter(b => !b.is_spare).length !== 1 ? 'es' : ''}{stock.some(b => b.is_spare) ? ` + spare` : ''}</span>
        </div>
        {stock.length === 0 ? (
          <p className="text-[var(--text-muted2)] text-sm">Nothing in stock</p>
        ) : (
          <>
            {Object.entries(stock.reduce((acc, b) => {
              const n = b.skus?.name || 'Unknown'
              if (!acc[n]) acc[n] = { available: 0, made: 0, spareAvailable: 0 }
              if (b.is_spare) acc[n].spareAvailable += b.available
              else { acc[n].available += b.available; acc[n].made += b.qty }
              return acc
            }, {})).map(([name, qty]) => (
              <div key={name} className="flex justify-between text-sm py-1">
                <span className="text-[var(--text-secondary)]">{name}</span>
                <span className="text-[var(--text-primary)] font-semibold">
                  {qty.available + qty.spareAvailable} <span className="text-[var(--text-muted2)] font-normal">/ {qty.made + qty.spareAvailable} pcs</span>
                  {qty.spareAvailable > 0 && <span className="text-[var(--text-gold)] font-normal text-xs ml-1">({qty.spareAvailable} spare)</span>}
                </span>
              </div>
            ))}
            <div className="mt-2 pt-2 border-t border-[var(--bg-input)]/40">
              {stock.map(b => {
                const days = Math.ceil((new Date(b.expires_on) - new Date()) / 86400000)
                return (
                  <div key={b.id} className="flex justify-between text-xs py-0.5">
                    <span className="text-[var(--text-muted2)]">
                      {b.skus?.name} · made {b.produced_on}
                      {b.is_spare && <span className="text-[var(--text-gold)] ml-1">(spare)</span>}
                    </span>
                    <span className={days <= 1 ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted)]'}>
                      {b.available}/{b.qty} pcs · {days}d left
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {(
        <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <button onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d.toLocaleDateString('en-CA')) }}
                className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] w-5 h-5 flex items-center justify-center">‹</button>
              <span className="text-[var(--text-primary)] text-sm font-semibold min-w-[7rem] text-center">
                {new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}
                
              </span>
              <button onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); const next = d.toLocaleDateString('en-CA'); if (next <= new Date().toLocaleDateString('en-CA')) setSelectedDate(next) }}
                disabled={selectedDate >= new Date().toLocaleDateString('en-CA')}
                className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed w-5 h-5 flex items-center justify-center">›</button>
              {selectedDate !== new Date().toLocaleDateString('en-CA') && (
                <button onClick={() => setSelectedDate(new Date().toLocaleDateString('en-CA'))}
                  className="ml-1 px-1.5 py-0.5 rounded-md bg-[var(--accent)]/15 text-[var(--accent)] text-[10px] font-semibold tracking-wide hover:bg-[var(--accent)]/25 transition-colors">GO TO TODAY</button>
              )}
            </div>
            {deliveriesToday.length > 0 && (
            <span className="text-[var(--text-muted2)] text-[10px]">{deliveriesToday.length} store{deliveriesToday.length !== 1 ? 's' : ''}</span>
          )}
          </div>
          {deliveriesToday.length === 0 ? (
            <p className="text-[var(--text-muted2)] text-sm py-1">{selectedDate === new Date().toLocaleDateString('en-CA') ? 'No deliveries or returns yet today' : 'No deliveries or returns this day'}</p>
          ) : (<>
          <div className="flex justify-between text-[10px] text-[var(--text-muted2)] uppercase tracking-wide pb-1">
            <span>Store</span>
            <span className="flex gap-6"><span className="w-12 text-right">Delivered</span><span className="w-12 text-right">Returned</span></span>
          </div>
          {deliveriesToday.slice(0, 6).map(d => (
            <div key={d.name} className="flex justify-between text-xs py-1 items-center">
              <span className="text-[var(--text-muted)] truncate pr-2">{d.name}</span>
              <span className="flex gap-6 shrink-0">
                <span className="w-12 text-right text-[var(--text-secondary)]">{d.qty || ''}</span>
                <span className={`w-12 text-right ${d.ret > 0 ? 'text-red-400' : 'text-[var(--text-muted2)]'}`}>{d.ret || ''}</span>
              </span>
            </div>
          ))}
          {deliveriesToday.length > 6 && (
            <button onClick={() => setShowAllDeliveries(true)}
              className="w-full text-[var(--accent)] text-xs py-1.5 hover:underline text-left">
              View all {deliveriesToday.length} stores ›
            </button>
          )}
          <div className="mt-2 pt-2 border-t border-[var(--bg-input)]/40 flex justify-between text-xs items-center">
            <span className="text-[var(--text-muted)]">Total</span>
            <span className="flex gap-6 shrink-0">
              <span className="w-12 text-right text-[var(--text-primary)] font-semibold">{deliveriesToday.reduce((n, d) => n + (Number(d.qty) || 0), 0) || ''}</span>
              <span className={`w-12 text-right font-semibold ${deliveriesToday.reduce((n, d) => n + (Number(d.ret) || 0), 0) > 0 ? 'text-red-400' : 'text-[var(--text-muted2)]'}`}>{deliveriesToday.reduce((n, d) => n + (Number(d.ret) || 0), 0) || ''}</span>
            </span>
          </div>
          </>)}
        </div>
      )}

      {showAllDeliveries && createPortal(
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col p-4"
          onClick={() => setShowAllDeliveries(false)}>
          <div onClick={e => e.stopPropagation()}
            className="m-2 mt-10 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-4 max-h-[80vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[var(--text-primary)] text-sm font-semibold">
                {new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} · all deliveries
              </span>
              <button onClick={() => setShowAllDeliveries(false)} className="text-[var(--text-muted)]"><X size={18} /></button>
            </div>
            <div className="flex justify-between text-[10px] text-[var(--text-muted2)] uppercase tracking-wide pb-1">
              <span>Store</span>
              <span className="flex gap-6"><span className="w-12 text-right">Delivered</span><span className="w-12 text-right">Returned</span></span>
            </div>
            {deliveriesToday.map(d => (
              <div key={d.name} className="flex justify-between text-xs py-1 items-center">
                <span className="text-[var(--text-muted)] truncate pr-2">{d.name}</span>
                <span className="flex gap-6 shrink-0">
                  <span className="w-12 text-right text-[var(--text-secondary)]">{d.qty || ''}</span>
                  <span className={`w-12 text-right ${d.ret > 0 ? 'text-red-400' : 'text-[var(--text-muted2)]'}`}>{d.ret || ''}</span>
                </span>
              </div>
            ))}
            <div className="mt-2 pt-2 border-t border-[var(--bg-input)]/40 flex justify-between text-xs items-center">
              <span className="text-[var(--text-muted)] font-semibold">Total ({deliveriesToday.length} stores)</span>
              <span className="flex gap-6 shrink-0">
                <span className="w-12 text-right text-[var(--text-primary)] font-semibold">{deliveriesToday.reduce((n, d) => n + (Number(d.qty) || 0), 0) || ''}</span>
                <span className={`w-12 text-right font-semibold ${deliveriesToday.reduce((n, d) => n + (Number(d.ret) || 0), 0) > 0 ? 'text-red-400' : 'text-[var(--text-muted2)]'}`}>{deliveriesToday.reduce((n, d) => n + (Number(d.ret) || 0), 0) || ''}</span>
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}

      <div className="flex gap-2">
        <button onClick={() => setQuickOpen(true)}
          className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold rounded-2xl py-3 transition-colors">
          Mark delivery / visit
        </button>
        <button onClick={() => setAddStoreOpen(true)}
          className="shrink-0 bg-[var(--bg-card)]/60 hover:bg-[var(--bg-input)]/60 border border-[var(--bg-input)]/50 text-[var(--text-secondary)] text-sm font-medium rounded-2xl px-4 transition-colors">
          + Store
        </button>
      </div>

      {quickOpen && <QuickDeliverModal onClose={() => setQuickOpen(false)} onSaved={() => window.location.reload()} />}
      {addStoreOpen && <AddStoreModal onClose={() => setAddStoreOpen(false)} onSaved={() => window.location.reload()} />}

      <button onClick={() => setShowFullMap(true)}
        className="relative h-40 shrink-0 rounded-2xl overflow-hidden bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50">
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
