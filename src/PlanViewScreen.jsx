import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import QuickDeliverModal from './QuickDeliverModal'
import AddStoreModal from './AddStoreModal'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import { Calendar, ChevronDown, Package, Zap, Gauge, Lock, Unlock, Save, Loader2, Navigation, CheckCircle, Circle, X, GripVertical, ChevronRight, ClipboardCheck } from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)
const START_HOUR = 9
const MAPS_CHUNK_SIZE = 8

function formatEta(minutesFromStart) {
  const totalMin = START_HOUR * 60 + minutesFromStart
  const h = Math.floor(totalMin / 60) % 24
  const m = Math.round(totalMin % 60)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function nnRoute(depotId, storeIds, cost, closeLoop = true) {
  const remaining = new Set(storeIds)
  const route = []
  let current = depotId
  while (remaining.size > 0) {
    let best = null, bestCost = Infinity
    for (const id of remaining) {
      const c = cost(current, id)
      if (c < bestCost) { bestCost = c; best = id }
    }
    route.push(best)
    remaining.delete(best)
    current = best
  }
  return route
}

function routeCost(depotId, route, cost, closeLoop = true) {
  let total = 0
  let prev = depotId
  for (const id of route) { total += cost(prev, id); prev = id }
  if (closeLoop) total += cost(prev, depotId)
  return total
}

function twoOpt(depotId, route, cost, closeLoop = true) {
  let improved = true
  let best = [...route]
  let bestCost = routeCost(depotId, best, cost, closeLoop)
  while (improved) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)]
        const candidateCost = routeCost(depotId, candidate, cost, closeLoop)
        if (candidateCost < bestCost - 0.0001) {
          best = candidate
          bestCost = candidateCost
          improved = true
        }
      }
    }
  }
  return { route: best, cost: bestCost }
}

const LIVE_ID = '__live__'

function haversineSec(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = x => x * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2
  const straightM = 2 * R * Math.asin(Math.sqrt(a))
  return (straightM * 1.4) / 6.94 // road factor 1.4x, Kerala avg ~25 km/h
}

function buildSequence(depotId, stopsInfo, cost, closeLoop = true) {
  const lockedStops = stopsInfo.filter(s => s.locked)
  const unlockedStops = stopsInfo.filter(s => !s.locked)
  const unlockedIds = unlockedStops.map(s => s.store_id)

  let orderedUnlocked = []
  if (unlockedIds.length > 0) {
    const seed = nnRoute(depotId, unlockedIds, cost, closeLoop)
    orderedUnlocked = twoOpt(depotId, seed, cost, closeLoop).route
  }

  const finalOrder = new Array(stopsInfo.length).fill(null)
  lockedStops.sort((a, b) => a.origIndex - b.origIndex).forEach(s => { finalOrder[s.origIndex] = s.store_id })

  let ui = 0
  for (let i = 0; i < finalOrder.length; i++) {
    if (finalOrder[i] === null) { finalOrder[i] = orderedUnlocked[ui]; ui++ }
  }
  return finalOrder
}

function buildMapsLinks(origin, orderedStoreObjs) {
  const points = orderedStoreObjs.filter(s => s.lat && s.lng)
  if (points.length === 0) return []
  const chunks = []
  for (let i = 0; i < points.length; i += MAPS_CHUNK_SIZE) {
    chunks.push(points.slice(i, i + MAPS_CHUNK_SIZE))
  }
  return chunks.map((chunk, idx) => {
    const chunkOrigin = idx === 0 ? `${origin.lat},${origin.lng}` : `${chunks[idx - 1].slice(-1)[0].lat},${chunks[idx - 1].slice(-1)[0].lng}`
    const isLast = idx === chunks.length - 1
    const destinationStop = chunk[chunk.length - 1]
    const destination = isLast ? `${origin.lat},${origin.lng}` : `${destinationStop.lat},${destinationStop.lng}`
    const waypointStops = isLast ? chunk : chunk.slice(0, -1)
    const waypoints = waypointStops.map(s => `${s.lat},${s.lng}`).join('|')
    const url = `https://www.google.com/maps/dir/?api=1&origin=${chunkOrigin}&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ''}&travelmode=driving`
    return { label: chunks.length > 1 ? `Leg ${idx + 1} (stops ${idx * MAPS_CHUNK_SIZE + 1}-${idx * MAPS_CHUNK_SIZE + chunk.length})` : 'Open in Google Maps', url }
  })
}



function MarkVisitedForm({ stop, onDone }) {
  const [open, setOpen] = useState(false)
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 bg-[var(--bg-input)]/60 hover:bg-[var(--accent)] hover:text-white text-[var(--text-muted)] text-xs font-medium rounded-lg px-3 py-1.5 transition-colors">
      ✓ Mark visited
    </button>
  )

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <input value={remark} onChange={e => setRemark(e.target.value)}
        placeholder="Remark (optional)"
        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]" />
      <div className="flex gap-2">
        <button onClick={async () => {
          setSaving(true)
          await supabase.from('plan_stops').update({
            visited_at: new Date().toISOString(),
            visit_remark: remark || null,
          }).eq('id', stop.id)
          setSaving(false)
          onDone()
        }} disabled={saving}
          className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors">
          {saving ? 'Saving...' : 'Confirm visit'}
        </button>
        <button onClick={() => setOpen(false)}
          className="text-[var(--text-muted2)] text-xs px-2">Cancel</button>
      </div>
    </div>
  )
}

function AddStopPanel({ planId, stops, selectedDate, onClose, onAdded }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState([])
  const [forecast, setForecast] = useState({})
  const [matrix, setMatrix] = useState({})
  const [depot, setDepot] = useState(null)
  const [preview, setPreview] = useState(null) // store to confirm
  const [adding, setAdding] = useState(false)

  useEffect(() => { (async () => {
    const [{ data: st }, { data: fc }, { data: mx }, { data: dep }] = await Promise.all([
      supabase.from('stores').select('id,name').eq('is_active',true).eq('is_depot',false).eq('exclude_from_forecast',false).order('name'),
      supabase.from('store_sales_summary').select('store_id,visit_count,revenue,last_visit,days_since_visit'),
      supabase.from('travel_matrix').select('from_store_id,to_store_id,seconds'),
      supabase.from('stores').select('id').eq('is_depot',true).maybeSingle(),
    ])
    const fcMap = {}
    ;(fc||[]).forEach(r => { fcMap[r.store_id] = r })
    const mxMap = {}
    ;(mx||[]).forEach(r => { mxMap[`${r.from_store_id}_${r.to_store_id}`] = r.seconds })
    setAll(st||[])
    setForecast(fcMap)
    setMatrix(mxMap)
    setDepot(dep)
  })() }, [])

  const todayIds = new Set(stops.map(s => s.store_id))
  const leg = (a, b) => a === b ? 0 : (matrix[`${a}_${b}`] ?? matrix[`${b}_${a}`] ?? 99999)

  function getBestPos(storeId) {
    const seq = [depot?.id, ...stops.map(s => s.store_id), depot?.id].filter(Boolean)
    let best = stops.length, bestCost = Infinity
    for (let i = 0; i < seq.length - 1; i++) {
      const cost = leg(seq[i], storeId) + leg(storeId, seq[i+1]) - leg(seq[i], seq[i+1])
      if (cost < bestCost) { bestCost = cost; best = i }
    }
    return { pos: best, addedMin: Math.round(Math.max(0, bestCost) / 60) }
  }

  const notToday = all
    .filter(s => !todayIds.has(s.id))
    .sort((a, b) => {
      const da = forecast[a.id]?.days_since_visit ?? 9999
      const db = forecast[b.id]?.days_since_visit ?? 9999
      return db - da
    })
  const matches = q.length > 1
    ? notToday.filter(s => s.name.toLowerCase().includes(q.toLowerCase())).slice(0,8)
    : notToday.slice(0,10)

  async function confirmAdd() {
    if (!preview || adding) return
    setAdding(true)
    const { pos } = getBestPos(preview.id)
    const insertOrder = pos + 1
    // Shift existing stops up to make room
    const toShift = stops.filter(s => s.stop_order >= insertOrder).sort((a,b) => b.stop_order - a.stop_order)
    for (const s of toShift) {
      await supabase.from('plan_stops').update({ stop_order: s.stop_order + 1 }).eq('id', s.id)
    }
    await supabase.from('plan_stops').insert({ plan_id: planId, store_id: preview.id, stop_order: insertOrder })
    setAdding(false)
    onAdded()
  }

  if (preview) {
    const fc = forecast[preview.id]
    const { pos, addedMin } = getBestPos(preview.id)
    const afterStop = (pos > 0 && stops[pos - 1]?.stores?.name) ? stops[pos - 1].stores.name : 'Depot'
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-[var(--bg-card)]/80 border border-[var(--accent)]/30 rounded-xl p-4">
          <div className="text-[var(--text-primary)] text-sm font-semibold mb-1">{preview.name}</div>
          <div className="text-[var(--text-muted2)] text-xs mb-2">
            Inserts after <span className="text-[var(--text-secondary)]">{afterStop}</span> · adds ~{addedMin} min
          </div>
          {fc && fc.visit_count > 0 ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[var(--bg-input)]/50 rounded-lg p-2">
                <div className="text-[var(--text-muted2)]">Last delivery</div>
                <div className="text-[var(--text-secondary)]">{fc.days_since_visit}d ago</div>
              </div>
              <div className="bg-[var(--bg-input)]/50 rounded-lg p-2">
                <div className="text-[var(--text-muted2)]">Total revenue</div>
                <div className="text-[var(--text-secondary)]">₹{Number(fc.revenue).toLocaleString('en-IN',{maximumFractionDigits:0})}</div>
              </div>
            </div>
          ) : (
            <div className="text-[var(--text-gold)] text-xs">No delivery history — new store</div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setPreview(null)}
            className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3 py-2">Back</button>
          <button onClick={confirmAdd} disabled={adding}
            className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-semibold rounded-xl py-2.5 transition-colors">
            {adding ? 'Adding...' : 'Add to route'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search or browse..."
        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-2" />
      {!q && <p className="text-[var(--text-muted2)] text-xs mb-2">Stores not on today's route</p>}
      {matches.map(s => {
        const fc = forecast[s.id]
        return (
          <button key={s.id} onClick={() => setPreview(s)}
            className="w-full text-left bg-[var(--bg-card)]/70 hover:bg-[var(--bg-input)]/60 rounded-xl px-4 py-3 mb-1.5 transition-colors">
            <div className="text-[var(--text-secondary)] text-sm">{s.name}</div>
            {fc && fc.visit_count > 0
              ? <div className="text-[var(--text-muted2)] text-xs mt-0.5">{fc.days_since_visit}d since last delivery · ₹{Number(fc.revenue).toLocaleString('en-IN',{maximumFractionDigits:0})} total</div>
              : <div className="text-[var(--text-gold)] text-xs mt-0.5">No delivery history</div>
            }
          </button>
        )
      })}
    </>
  )
}


function MapsCard({ links }) {
  const [open, setOpen] = useState(false)
  if (links.length === 1) {
    return (
      <a href={links[0].url} target="_blank" rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 bg-[var(--bg-card)] hover:bg-[var(--bg-input)] text-[var(--text-accent)] text-xs font-medium rounded-lg py-2 transition-colors w-full">
        <Navigation size={13} /> Open in Google Maps
      </a>
    )
  }
  return (
    <div>
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center justify-center gap-2 bg-[var(--bg-card)] hover:bg-[var(--bg-input)] text-[var(--text-accent)] text-xs font-medium rounded-lg py-2 transition-colors w-full">
        <Navigation size={13} /> Open in Google Maps · {links.length} legs {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 mt-1.5">
          {links.map((link, i) => (
            <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 bg-[var(--bg-card)]/70 hover:bg-[var(--bg-input)] text-[var(--text-secondary)] text-xs rounded-lg py-2 transition-colors">
              <Navigation size={12} /> {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PlanViewScreen() {
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(today())
  const [stops, setStops] = useState([])
  const [loading, setLoading] = useState(true)
  const [depot, setDepot] = useState(null)
  const [storeCoords, setStoreCoords] = useState({})
  const [matrixSeconds, setMatrixSeconds] = useState({})
  const [matrixMeters, setMatrixMeters] = useState({})
  const [metric, setMetric] = useState('seconds')
  const [order, setOrder] = useState([])
  const [quickOpen, setQuickOpen] = useState(false)
  const [planId, setPlanId] = useState(null)
  const [addStopOpen, setAddStopOpen] = useState(false)
  const phones = useStoreContacts()
  const [priorLines, setPriorLines] = useState({})   // sku_id -> earlier delivery lines
  const [allSkus, setAllSkus] = useState([])
  const [extraReqs, setExtraReqs] = useState([])     // impulse-added SKUs
  const [addSkuOpen, setAddSkuOpen] = useState(false)
  const [showHistoryFor, setShowHistoryFor] = useState(null) // sku_id
  const [locked, setLocked] = useState({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [completedStopIds, setCompletedStopIds] = useState(new Set())
  const [skippedStopIds, setSkippedStopIds] = useState(new Set())
  const [activeCompleteStop, setActiveCompleteStop] = useState(null)
  const [completeForm, setCompleteForm] = useState({})
  const [completing, setCompleting] = useState(false)
  const [batches, setBatches] = useState([])
  const [useLiveOrigin, setUseLiveOrigin] = useState(false)
  const [liveCoords, setLiveCoords] = useState(null)

  async function loadDates() {
    // Only plans that have stops, sorted oldest-first so the dropdown reads
    // chronologically. Auto-select the nearest upcoming (or most recent) date.
    const { data } = await supabase
      .from('plans')
      .select('plan_date, plan_stops(id)')
      .gte('plan_date', new Date().toISOString().slice(0, 10))
      .order('plan_date', { ascending: true })
      .limit(14)
    const withStops = [...new Set(
      (data || []).filter(d => d.plan_stops?.length > 0).map(d => d.plan_date)
    )]
    setDates(withStops)
    if (withStops.length > 0) {
      const today = new Date().toISOString().slice(0, 10)
      const upcoming = withStops.find(d => d >= today) || withStops[withStops.length - 1]
      setSelectedDate(upcoming)
    }
  }

  async function loadBatches() {
    const { data } = await supabase.from('production_batches')
      .select('id, sku_id, produced_on, expires_on, qty, delivery_lines(qty_delivered)')
      .gt('expires_on', today())
      .order('produced_on')
    setBatches(data || [])
  }

  async function loadMatrix() {
    const { data: depotRow } = await supabase.from('stores').select('id, lat, lng').eq('is_depot', true).maybeSingle()
    setDepot(depotRow)
    const { data: allStores } = await supabase.from('stores').select('id, lat, lng').eq('is_active', true)
    const coordMap = {}
    allStores?.forEach(s => { coordMap[s.id] = { lat: s.lat, lng: s.lng } })
    setStoreCoords(coordMap)
    const { data: matrix } = await supabase.from('travel_matrix').select('from_store_id, to_store_id, seconds, meters')
    const secMap = {}, metMap = {}
    matrix?.forEach(m => {
      secMap[`${m.from_store_id}_${m.to_store_id}`] = m.seconds
      metMap[`${m.from_store_id}_${m.to_store_id}`] = m.meters
    })
    setMatrixSeconds(secMap)
    setMatrixMeters(metMap)
  }

  async function loadPlan(date) {
    setLoading(true)
    const { data: plan } = await supabase.from('plans').select('id, status').eq('plan_date', date).maybeSingle()
    setPlanId(plan?.id || null)
    if (!plan) { setStops([]); setOrder([]); setLoading(false); return }

    const { data } = await supabase
      .from('plan_stops')
      .select('id, stop_order, store_id, locked, stores(id, name), requirements(id, sku_id, proposed_qty, approved_qty, skus(name, shelf_life_days, min_delivery_qty))')
      .eq('plan_id', plan.id)
      .order('stop_order')

    const withReqs = data || []
    setStops(withReqs)
    const lockMap = {}
    withReqs.forEach(s => { lockMap[s.store_id] = s.locked })
    setLocked(lockMap)
    setOrder(withReqs.map(s => s.store_id))

    // Check which stops are completed — via plan_stop_id OR quick delivery (store+date)
    const stopIds = withReqs.map(s => s.id)
    const storeIds = withReqs.map(s => s.store_id)
    if (stopIds.length > 0) {
      const [{ data: existingDL }, { data: quickDL }] = await Promise.all([
        supabase.from('delivery_lines').select('plan_stop_id').in('plan_stop_id', stopIds),
        supabase.from('delivery_lines').select('store_id').in('store_id', storeIds).eq('delivered_on', date),
      ])
      const completedByPlan = new Set((existingDL || []).map(d => d.plan_stop_id))
      const deliveredStoreIds = new Set((quickDL || []).map(d => d.store_id))
      setCompletedStopIds(new Set(
        withReqs.filter(s => completedByPlan.has(s.id) || deliveredStoreIds.has(s.store_id)).map(s => s.id)
      ))
    } else {
      setCompletedStopIds(new Set())
    }
    setLoading(false)
  }

  useEffect(() => { loadDates(); loadMatrix(); loadBatches() }, [])
  useEffect(() => { loadPlan(selectedDate) }, [selectedDate])

  useEffect(() => {
    if (stops.length > 0 && depot?.id && Object.keys(matrixSeconds).length > 0) {
      optimize('seconds')
    }
    // eslint-disable-next-line
  }, [stops, depot, matrixSeconds])

  function cost(a, b, m) {
    const map = m === 'seconds' ? matrixSeconds : matrixMeters
    if (a === b) return 0
    return map[`${a}_${b}`] ?? map[`${b}_${a}`] ?? 99999
  }

  function optimize(useMetric, liveCoordsOverride, forceLive) {
    if (!depot?.id || stops.length === 0) return
    const live = liveCoordsOverride || liveCoords
    const shouldUseLive = forceLive !== undefined ? forceLive : useLiveOrigin
    const originId = shouldUseLive && live ? LIVE_ID : depot.id
    const inputStops = stops.map((s, idx) => ({ store_id: s.store_id, locked: !!locked[s.store_id], origIndex: idx }))
    const costFn = (a, b) => {
      if (a === LIVE_ID || b === LIVE_ID) {
        const storeId = a === LIVE_ID ? b : a
        const sc = storeCoords[storeId]
        if (!sc || !live) return 99999
        return haversineSec(live.lat, live.lng, sc.lat, sc.lng)
      }
      return cost(a, b, useMetric)
    }
    const closeLoop = originId !== LIVE_ID
    const newOrder = buildSequence(originId, inputStops, costFn, closeLoop)
    setOrder(newOrder)
    setMetric(useMetric)
  }

  function toggleLiveOrigin() {
    const next = !useLiveOrigin
    setUseLiveOrigin(next)
    if (next) {
      navigator.geolocation?.getCurrentPosition(
        pos => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
          setLiveCoords(coords)
          optimize(metric, coords, true)
        },
        () => { setUseLiveOrigin(false); alert('Could not get your location.') },
        { enableHighAccuracy: true, timeout: 8000 }
      )
    } else {
      setLiveCoords(null)
      optimize(metric, null, false)
    }
  }

  async function saveOrder() {
    setSaving(true)
    for (let i = 0; i < order.length; i++) {
      const storeId = order[i]
      const stop = stops.find(s => s.store_id === storeId)
      if (!stop) continue
      await supabase.from('plan_stops').update({ stop_order: i + 1, locked: !!locked[storeId] }).eq('id', stop.id)
    }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function toggleSkip(stopId) {
    setSkippedStopIds(s => {
      const n = new Set(s)
      if (n.has(stopId)) n.delete(stopId)
      else n.add(stopId)
      return n
    })
  }

  function toggleLock(storeId) {
    setLocked(l => ({ ...l, [storeId]: !l[storeId] }))
  }

  function batchesForSku(skuId) {
    return batches.filter(b => b.sku_id === skuId)
  }

  async function openCompleteForm(stop) {
    const initial = {}
    stop.requirements.forEach(r => {
      const skuBatches = batchesForSku(r.sku_id)
      initial[r.sku_id] = {
        qty_delivered: r.approved_qty ?? r.proposed_qty ?? 0,
        qty_returned: '',
        return_line_id: '',
        batch_id: skuBatches[0]?.id || '',
        unit_price: '',
        is_offer: false,
        store_balance: '',
      }
    })
    setCompleteForm(initial)
    setExtraReqs([])
    setAddSkuOpen(false)
    setActiveCompleteStop(stop)

    const [{ data: skus }, { data: prior }, { data: storePrices }, { data: lastPrices }] = await Promise.all([
      supabase.from('skus').select('id, name, unit_price').order('name'),
      supabase.from('delivery_lines')
        .select('id, sku_id, qty_delivered, delivered_on, unit_price, is_offer, production_batches(produced_on), returns(qty_returned), plan_stops!inner(store_id)')
        .eq('plan_stops.store_id', stop.store_id)
        .order('delivered_on', { ascending: false })
        .limit(80),
      supabase.from('store_sku_price_latest').select('sku_id, price').eq('store_id', stop.store_id),
      supabase.from('delivery_lines')
        .select('sku_id, unit_price')
        .eq('store_id', stop.store_id)
        .not('unit_price', 'is', null)
        .order('delivered_on', { ascending: false })
        .limit(20),
    ])
    const storePriceMap = {}
    ;(storePrices || []).forEach(p => { storePriceMap[p.sku_id] = p.price })
    const lastPriceMap = {}
    ;(lastPrices || []).forEach(l => { if (!lastPriceMap[l.sku_id]) lastPriceMap[l.sku_id] = l.unit_price })
    // Back-fill prices into form
    setCompleteForm(f => {
      const updated = { ...f }
      Object.keys(updated).forEach(skuId => {
        const skuData = (skus || []).find(s => s.id === skuId)
        updated[skuId] = { ...updated[skuId], unit_price: lastPriceMap[skuId] ?? storePriceMap[skuId] ?? skuData?.unit_price ?? '' }
      })
      return updated
    })
    setAllSkus(skus || [])

    const grouped = {}
    ;(prior || []).forEach(l => {
      const already = (l.returns || []).reduce((a, r) => a + (r.qty_returned || 0), 0)
      if (!grouped[l.sku_id]) grouped[l.sku_id] = []
      grouped[l.sku_id].push({
        id: l.id,
        delivered_on: l.delivered_on,
        produced_on: l.production_batches?.produced_on || null,
        qty_delivered: l.qty_delivered,
        already_returned: already,
        unit_price: l.unit_price || null,
        is_offer: l.is_offer || false,
      })
    })
    setPriorLines(grouped)
  }

  // DD/MM/YYYY -> ISO. Returns null if not a real date.
  function parseDMY(s) {
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec((s || '').trim())
    if (!m) return null
    const [, d, mo, y] = m
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    const dt = new Date(iso + 'T00:00:00')
    if (isNaN(dt) || dt.getDate() !== Number(d) || dt.getMonth() + 1 !== Number(mo)) return null
    return iso
  }

  // Exact batch match only. If nothing was made that day we say so and stop —
  // Takes an ISO date straight from the picker. Matches the production date
  // when the delivery recorded a batch, otherwise the delivery date, since
  // imported history carries no batch at all.
  function resolveReturnLine(skuId, iso) {
    if (!iso) return { id: '', status: 'empty' }
    const prior = priorLines[skuId] || []
    const hit = prior.find(p => p.produced_on === iso) || prior.find(p => p.delivered_on === iso)
    if (!hit) return { id: '', status: 'nomatch' }
    return {
      id: hit.id,
      status: 'ok',
      note: (hit.produced_on ? `Made ${hit.produced_on} · ` : '') +
        `delivered ${hit.qty_delivered} pcs on ${hit.delivered_on}` +
        (hit.already_returned > 0 ? ` · ${hit.already_returned} already returned` : ''),
    }
  }

  function addExtraSku(skuId) {
    if (!skuId) return
    const sku = allSkus.find(s => s.id === skuId)
    if (!sku) return
    const skuBatches = batchesForSku(skuId)
    setExtraReqs(e => [...e, { sku_id: skuId, name: sku.name }])
    setCompleteForm(f => ({ ...f, [skuId]: { qty_delivered: 0, qty_returned: '', return_line_id: '', batch_id: skuBatches[0]?.id || '' } }))
    setAddSkuOpen(false)
  }

  function removeExtraSku(skuId) {
    setExtraReqs(e => e.filter(x => x.sku_id !== skuId))
    setCompleteForm(f => { const n = { ...f }; delete n[skuId]; return n })
  }

  function completeFormValid() {
    if (!activeCompleteStop) return false
    const rows = [...activeCompleteStop.requirements.map(r => ({ sku_id: r.sku_id })), ...extraReqs]
    return rows.every(r => {
      const line = completeForm[r.sku_id]
      if (!line) return false
      if (Number(line.qty_delivered) > 0 && !line.batch_id) return false
      return true
    })
  }

  async function submitComplete() {
    if (!activeCompleteStop || !completeFormValid()) return
    setCompleting(true)
    const dateStr = selectedDate
    // Impulse-added SKUs need a requirements row first, marked manual so it is
    // distinguishable from forecast-generated rows.
    for (const extra of extraReqs) {
      const line = completeForm[extra.sku_id]
      await supabase.from('requirements').insert({
        plan_stop_id: activeCompleteStop.id,
        sku_id: extra.sku_id,
        proposed_qty: 0,
        approved_qty: Number(line?.qty_delivered) || 0,
        source: 'manual',
      })
    }

    const rows = [
      ...activeCompleteStop.requirements.map(r => ({ sku_id: r.sku_id })),
      ...extraReqs.map(e => ({ sku_id: e.sku_id })),
    ]

    for (const req of rows) {
      const line = completeForm[req.sku_id]
      if (!line) continue
      await supabase.from('delivery_lines').insert({
        plan_stop_id: activeCompleteStop.id,
        sku_id: req.sku_id,
        batch_id: line.batch_id || null,
        qty_delivered: Number(line.qty_delivered) || 0,
        delivered_on: dateStr,
        store_id: activeCompleteStop.store_id,
        unit_price: line.unit_price !== '' ? Number(line.unit_price) : null,
        is_offer: line.is_offer || false,
        store_balance: line.store_balance !== '' && line.store_balance !== undefined ? Number(line.store_balance) : null,
      })
      // Returns belong to the EARLIER delivery that carried the stock,
      // never to the line we just created.
      if (Number(line.qty_returned) > 0) {
        // Link to the delivery when we can identify it. When we can't, record
        // the return against the store and SKU instead of guessing a delivery —
        // a wrong link corrupts that delivery's sold figure permanently.
        await supabase.from('returns').insert({
          delivery_line_id: line.return_line_id || null,
          store_id: activeCompleteStop.store_id,
          sku_id: req.sku_id,
          produced_on: line.return_date_text || null,
          qty_returned: Number(line.qty_returned),
          returned_on: dateStr,
          possible_stockout: false,
          reason: line.return_line_id ? null : 'No matching delivery on record',
        })
      }
    }
    setCompletedStopIds(s => new Set([...s, activeCompleteStop.id]))
    setCompleting(false)
    setActiveCompleteStop(null)
  }

  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)
  const [dragY, setDragY] = useState(0)

  // Pointer events rather than HTML5 drag-and-drop, which never fires on
  // mobile browsers — where this list is actually used.
  function startDrag(e, idx) {
    e.preventDefault()
    setDragIdx(idx)
    setOverIdx(idx)
    let target = idx
    const startY = e.clientY
    const move = ev => {
      const pt = ev.touches ? ev.touches[0] : ev
      setDragY(pt.clientY - startY)
      const el = document.elementFromPoint(pt.clientX, pt.clientY)
      const row = el && el.closest('[data-stop-idx]')
      if (row) { target = Number(row.getAttribute('data-stop-idx')); setOverIdx(target) }
    }
    const end = () => {
      if (target !== idx) {
        setOrder(prev => {
          const next = [...prev]
          const [moved] = next.splice(idx, 1)
          next.splice(target, 0, moved)
          return next
        })
        const movedId = order[idx]
        // A stop placed by hand is locked so re-optimising cannot undo it.
        if (movedId) setLocked(l => ({ ...l, [movedId]: true }))
      }
      setDragIdx(null)
      setOverIdx(null)
      setDragY(0)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  const orderedStops = order.map(id => stops.find(s => s.store_id === id)).filter(Boolean)
  let cumMinutes = 0
  const legInfo = orderedStops.map((s, idx) => {
    const prevId = idx === 0 ? depot?.id : order[idx - 1]
    const legSeconds = cost(prevId, s.store_id, 'seconds')
    const legMeters = cost(prevId, s.store_id, 'meters')
    cumMinutes += legSeconds / 60
    const arrival = cumMinutes
    cumMinutes += 15
    return { legMinutes: legSeconds / 60, legKm: legMeters / 1000, eta: arrival }
  })

  const totalSeconds = depot?.id ? routeCost(depot.id, order, (a, b) => cost(a, b, 'seconds')) : 0
  const totalMeters = depot?.id ? routeCost(depot.id, order, (a, b) => cost(a, b, 'meters')) : 0

  const totalsBySku = {}
  stops.forEach(stop => {
    stop.requirements?.forEach(req => {
      const name = req.skus?.name
      const qty = req.approved_qty ?? req.proposed_qty ?? 0
      if (name) totalsBySku[name] = (totalsBySku[name] || 0) + qty
    })
  })

  const orderedStoreObjs = orderedStops
    .filter(s => !skippedStopIds.has(s.id))
    .map(s => ({ id: s.store_id, ...storeCoords[s.store_id] }))
  const mapsOrigin = (useLiveOrigin && liveCoords) ? liveCoords : (depot ? { lat: depot.lat, lng: depot.lng } : null)
  const mapsLinks = mapsOrigin ? buildMapsLinks(mapsOrigin, orderedStoreObjs) : []
  const completedCount = orderedStops.filter(s => completedStopIds.has(s.id)).length

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
        <Calendar size={15} className="text-[var(--text-accent)]" />
        <div className="relative flex-1">
          <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
            className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] text-sm rounded-lg px-3 py-2 outline-none appearance-none">
            {dates.map(d => <option key={d} value={d}>{d}{d === today() ? ' (today)' : ''}</option>)}
            {!dates.includes(today()) && <option value={today()}>{today()} (today) — no plan</option>}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-2.5 text-[var(--text-muted)] pointer-events-none" />
        </div>
      </div>

      {Object.keys(totalsBySku).length > 0 && (
        <div className="px-4 py-3 bg-[var(--bg-card)]/60 border-b border-[var(--bg-input)] flex flex-wrap gap-3 shrink-0">
          {Object.entries(totalsBySku).map(([sku, qty]) => (
            <div key={sku} className="text-[var(--text-primary)] text-sm font-semibold">{sku}: <span className="text-[var(--text-accent)]">{qty} pcs</span></div>
          ))}
        </div>
      )}

      {stops.length > 0 && (
        <>
          <div className="px-4 py-2 bg-[var(--bg-root)] border-b border-[var(--bg-card)] shrink-0">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-2">
              <span>{Math.round(totalSeconds / 60)} min drive · {(totalMeters / 1000).toFixed(1)} km · {completedCount}/{orderedStops.length} done</span>
              <div className="flex items-center gap-3">
                <button onClick={() => setAddStopOpen(true)}
                  className="flex items-center gap-1 text-[var(--text-accent)] hover:text-[var(--text-accent2)]">
                  + Add visit
                </button>
                <button onClick={saveOrder} disabled={saving} className="flex items-center gap-1 text-[var(--text-accent)] hover:text-[var(--text-accent2)] disabled:opacity-50">
                  {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <span className="text-[var(--accent)]">Saved!</span> : <><Save size={13} /> Save order</>}
                </button>
              </div>
            </div>
            <div className="flex gap-2 mb-2">
              <button onClick={() => optimize('seconds')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${metric === 'seconds' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
                <Zap size={12} /> Fastest {metric === 'seconds' ? `· ${Math.round(totalSeconds/60)}m` : ''}
              </button>
              <button onClick={() => optimize('meters')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${metric === 'meters' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
                <Gauge size={12} /> Shortest {metric === 'meters' ? `· ${(totalMeters/1000).toFixed(1)}km` : ''}
              </button>
            </div>
            {mapsLinks.length > 0 && (
              <MapsCard links={mapsLinks} />
            )}
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Loading...</div>}
        {!loading && stops.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No plan for this date</p>
          </div>
        )}
        {orderedStops.length > 0 && (
          <button onClick={toggleLiveOrigin}
            className="w-full bg-[var(--bg-card)]/60 rounded-xl p-3 text-xs flex items-center gap-2 hover:bg-[var(--bg-input)]/60 transition-colors">
            <span className={useLiveOrigin ? 'text-[var(--accent)]' : 'text-[var(--text-gold)]'}>●</span>
            <span className="text-[var(--text-muted)] flex-1 text-left">
              {useLiveOrigin ? 'Start: Live location (9:00 AM)' : 'Start: Depot (9:00 AM)'}
            </span>
            <span className={`px-2 py-0.5 rounded-lg font-medium ${useLiveOrigin ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'bg-[var(--bg-input)] text-[var(--text-muted2)]'}`}>
              {useLiveOrigin ? '📍 Live' : '🏠 Depot'} · tap to switch
            </span>
          </button>
        )}
        {orderedStops.map((stop, idx) => {
          const isDone = completedStopIds.has(stop.id)
          return (
            <div key={stop.id} data-stop-idx={idx}
              style={(() => {
                if (dragIdx === idx) return { transform: `translateY(${dragY}px) scale(1.03)`, zIndex: 30, position: 'relative', boxShadow: '0 12px 28px rgba(0,0,0,.45)', transition: 'none', pointerEvents: 'none' }
                if (dragIdx === null || overIdx === null) return undefined
                if (idx > dragIdx && idx <= overIdx) return { transform: 'translateY(-6px)' }
                if (idx < dragIdx && idx >= overIdx) return { transform: 'translateY(6px)' }
                return undefined
              })()}
              className={`bg-[var(--bg-card)] rounded-xl p-4 ${isDone || skippedStopIds.has(stop.id) ? 'opacity-50' : ''} ${dragIdx === idx ? 'ring-2 ring-[var(--accent)]' : 'transition-transform duration-150'} ${dragIdx !== null && dragIdx !== idx ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span onPointerDown={e => startDrag(e, idx)}
                    className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0 cursor-grab active:cursor-grabbing touch-none">
                    <GripVertical size={14} className={dragIdx === idx ? 'text-[var(--accent)]' : ''} />
                  </span>
                  <button onClick={() => toggleLock(stop.store_id)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0">
                    {locked[stop.store_id] ? <Lock size={13} className="text-[var(--text-gold)]" /> : <Unlock size={13} />}
                  </button>
                  <span className="text-[var(--text-primary)] text-sm font-medium truncate">{idx + 1}. {stop.stores?.name}</span>
                  <ContactButtons phone={phones[stop.store_id]} />
                </div>
                <span className="text-[var(--text-muted2)] text-xs shrink-0">ETA {formatEta(legInfo[idx]?.eta || 0)}</span>
              </div>
              <div className="text-[var(--text-muted2)] text-xs pl-5 mb-1">
                +{Math.round(legInfo[idx]?.legMinutes || 0)} min · {(legInfo[idx]?.legKm || 0).toFixed(1)} km from previous
              </div>
              {(!stop.requirements || stop.requirements.length === 0 || stop.requirements.every(r => (r.approved_qty ?? r.proposed_qty) === 0)) && (
                <div className="text-[var(--text-muted2)] text-xs pl-5 italic">Visit only</div>
              )}
              {stop.requirements?.filter(r => (r.approved_qty ?? r.proposed_qty) > 0).map(req => {
                const qty = req.approved_qty ?? req.proposed_qty
                const moq = req.skus?.min_delivery_qty || 0
                const dl = req.delivery_line
                return (
                  <div key={req.id} className="text-[var(--text-muted)] text-xs flex justify-between pl-5">
                    <span className="flex items-center gap-1">
                      {req.skus?.name}
                      {dl?.is_offer && <span className="text-[var(--text-gold)] text-[10px] font-semibold">OFFER</span>}
                    </span>
                    <span className="text-[var(--text-secondary)]">
                      {qty} {qty === 1 ? 'pc' : 'pcs'}
                      {dl?.unit_price && <span className="text-[var(--text-muted2)]"> · ₹{dl.unit_price}</span>}
                      {moq > 0 && qty < moq && <span className="text-[var(--text-gold)]"> · MOQ {moq}</span>}
                    </span>
                  </div>
                )
              })}
              <div className="pl-5 mt-2">
                {skippedStopIds.has(stop.id) ? (
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-[var(--text-muted2)] text-xs">
                      Skipped
                    </span>
                    <button onClick={() => toggleSkip(stop.id)}
                      className="text-[var(--accent)] text-xs hover:opacity-80">
                      Undo
                    </button>
                  </div>
                ) : isDone ? (
                  <span className="flex items-center gap-1.5 text-[var(--accent)] text-xs">
                    <CheckCircle size={14} /> Delivered
                  </span>
                ) : (
                  (!stop.requirements || stop.requirements.length === 0) ? (
                    <MarkVisitedForm stop={stop} onDone={() => setCompletedStopIds(s => new Set([...s, stop.id]))} />
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => openCompleteForm(stop)}
                        className="flex items-center gap-1.5 bg-[var(--bg-input)]/60 hover:bg-[var(--accent)] hover:text-white text-[var(--text-accent)] text-xs font-medium rounded-lg px-3 py-1.5 transition-colors">
                        <ClipboardCheck size={13} /> Record delivery <ChevronRight size={12} className="opacity-70" />
                      </button>
                      <button onClick={() => toggleSkip(stop.id)}
                        className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-xs px-2 py-1.5 rounded-lg bg-[var(--bg-input)]/40 transition-colors">
                        Skip
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
          )
        })}
      </div>

      {quickOpen && <QuickDeliverModal onClose={() => setQuickOpen(false)} onSaved={() => loadPlan?.()} />}
      {addStopOpen && planId && (
        <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
            <span className="text-[var(--text-primary)] font-semibold">Add stop to today</span>
            <button onClick={() => setAddStopOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-[var(--text-muted2)] text-xs mb-4">Search for a store to add as a visit-only stop. No delivery will be planned — use this for prospecting or relationship visits.</p>
            <AddStopPanel planId={planId} stops={stops} selectedDate={selectedDate}
              onClose={() => setAddStopOpen(false)}
              onAdded={() => { setAddStopOpen(false); loadPlan(selectedDate) }} />
          </div>
        </div>
      )}

      {activeCompleteStop && (
        <div className="absolute inset-0 bg-[var(--bg-root)]/70 backdrop-blur-2xl backdrop-saturate-150 flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0 bg-[var(--bg-card)]/40 backdrop-blur-xl">
            <h2 className="text-[var(--text-primary)] font-semibold">{activeCompleteStop.stores?.name}</h2>
            <button onClick={() => setActiveCompleteStop(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-4">
            {[...activeCompleteStop.requirements.map(r => ({ key: r.id, sku_id: r.sku_id, name: r.skus?.name, extra: false })),
              ...extraReqs.map(e => ({ key: 'x-' + e.sku_id, sku_id: e.sku_id, name: e.name, extra: true }))].map(row => {
              const skuBatches = batchesForSku(row.sku_id)
              const line = completeForm[row.sku_id] || {}
              const needsBatch = Number(line.qty_delivered) > 0 && !line.batch_id
              const prior = priorLines[row.sku_id] || []
              const recentHistory = prior.slice(0, 5)
              const needsReturnLine = Number(line.qty_returned) > 0 && !line.return_line_id
              const req = { sku_id: row.sku_id }
              return (
                <div key={row.key} className="bg-[var(--bg-card)]/80 backdrop-blur-xl border border-[var(--bg-input)]/40 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[var(--text-primary)] text-sm font-medium">{row.name}{row.extra && <span className="text-[var(--text-gold)] text-xs ml-2">trial</span>}</span>
                    {row.extra && <button onClick={() => removeExtraSku(row.sku_id)} className="text-[var(--text-muted2)] hover:text-red-400"><X size={14} /></button>}
                  </div>
                  <div className="mb-3">
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Production batch {needsBatch && <span className="text-red-400">*</span>}</label>
                    <div className="flex flex-col gap-1.5">
                      {skuBatches.length === 0 && <p className="text-[var(--text-gold)] text-xs">⚠ No active batches for this product</p>}
                      {skuBatches.map(b => {
                        const avail = Math.max(0, b.qty - (b.delivery_lines || []).reduce((n, l) => n + (l.qty_delivered || 0), 0))
                        const selected = line.batch_id === b.id
                        return (
                          <button key={b.id}
                            onClick={() => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], batch_id: b.id } }))}
                            className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${selected ? 'bg-[var(--accent)]/20 border border-[var(--accent)] text-[var(--accent)]' : 'bg-[var(--bg-input)] text-[var(--text-primary)] border border-transparent'}`}>
                            <div className="font-medium">Made {b.produced_on}</div>
                            <div className="text-xs opacity-70">Expires {b.expires_on} · {avail} pcs left</div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[var(--text-muted)] text-xs mb-1 block">Delivered</label>
                      <input type="number"
                        value={line.qty_delivered ?? ''}
                        onChange={e => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], qty_delivered: e.target.value } }))}
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                    </div>
                    <div>
                      <label className="text-[var(--text-muted)] text-xs mb-1 block">Returned</label>
                      <input type="number" placeholder="0"
                        value={line.qty_returned ?? ''}
                        onChange={e => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], qty_returned: e.target.value } }))}
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex-1">
                      <label className="text-[var(--text-muted)] text-xs mb-1 block">Price per pc (₹)</label>
                      <input type="number" min="0" step="0.01"
                        value={line.unit_price ?? ''}
                        onChange={e => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], unit_price: e.target.value } }))}
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                    </div>
                    <div className="pt-5">
                      <button
                        onClick={() => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], is_offer: !f[req.sku_id]?.is_offer } }))}
                        className={`text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${line.is_offer ? 'bg-[var(--text-gold)]/20 border-[var(--text-gold)] text-[var(--text-gold)]' : 'border-[var(--bg-input)] text-[var(--text-muted2)] hover:border-[var(--text-gold)] hover:text-[var(--text-gold)]'}`}>
                        OFFER
                      </button>
                    </div>
                  </div>
                  {line.unit_price !== '' && Number(line.unit_price) > 0 && Number(line.qty_delivered) > 0 && (
                    <div className="text-[var(--text-muted2)] text-xs mb-2">
                      Billed: ₹{((Number(line.qty_delivered) - Number(line.qty_returned || 0)) * Number(line.unit_price)).toFixed(2)}
                      {line.is_offer && <span className="ml-1 text-[var(--text-gold)]">· offer price</span>}
                    </div>
                  )}
                  <div className="mt-3 border-t border-[var(--bg-input)]/30 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[var(--text-muted)] text-xs">Store balance before delivery</label>
                      <input type="number" min="0" placeholder="pcs left at store"
                        value={line.store_balance ?? ''}
                        onChange={e => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], store_balance: e.target.value } }))}
                        className="w-28 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-xs outline-none text-center" />
                    </div>
                  </div>
                  {recentHistory.length > 0 && (
                    <div className="mt-2 border-t border-[var(--bg-input)]/30 pt-2">
                      <button onClick={() => setShowHistoryFor(showHistoryFor === row.sku_id ? null : row.sku_id)}
                        className="text-[var(--text-muted2)] text-[10px] uppercase tracking-wide flex items-center gap-1 w-full">
                        Recent deliveries {showHistoryFor === row.sku_id ? '▲' : '▼'}
                      </button>
                      {showHistoryFor === row.sku_id && recentHistory.map((h, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 border-t border-[var(--bg-input)]/20 first:border-0 mt-1">
                          <span className="text-[var(--text-muted2)]">{h.delivered_on}</span>
                          <span className="text-[var(--text-secondary)] flex items-center gap-1.5">
                            {h.qty_delivered} pcs
                            {h.already_returned > 0 && <span className="text-red-400">· {h.already_returned} ret</span>}
                            {h.unit_price && <span className="text-[var(--text-muted2)]">· ₹{h.unit_price}</span>}
                            {h.is_offer && <span className="text-[var(--text-gold)] text-[10px] font-semibold">OFFER</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {Number(line.qty_returned) > 0 && (() => {
                    const res = resolveReturnLine(req.sku_id, line.return_date_text)
                    const pretty = line.return_date_text
                      ? new Date(line.return_date_text + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                      : null
                    return (
                      <div className="mt-3">
                        <label className="text-[var(--text-muted)] text-xs mb-1 block">Production date on the returned pack</label>
                        <input type="date" value={line.return_date_text || ''}
                          max={selectedDate}
                          onChange={ev => {
                            const v = ev.target.value
                            const r = resolveReturnLine(req.sku_id, v)
                            setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], return_date_text: v, return_line_id: r.id } }))
                          }}
                          className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                        {pretty && <p className="text-[var(--text-secondary)] text-xs mt-1">{pretty}</p>}
                        {prior[0] && res.status !== 'ok' && (
                          <p className="text-[var(--text-muted2)] text-xs mt-1">
                            Last delivery here: {prior[0].delivered_on} · {prior[0].qty_delivered} pcs
                          </p>
                        )}
                        {res.status === 'nomatch' && <p className="text-[var(--text-gold)] text-xs mt-1">No delivery on record for that date — saved as an unlinked return against this store</p>}
                        {res.status === 'ok' && <p className="text-[var(--accent)] text-xs mt-1">{res.note}</p>}
                      </div>
                    )
                  })()}
                </div>
              )
            })}

            {(() => {
              const used = new Set([...activeCompleteStop.requirements.map(r => r.sku_id), ...extraReqs.map(x => x.sku_id)])
              const available = allSkus.filter(s => !used.has(s.id))
              if (available.length === 0) return null
              return addSkuOpen ? (
                <select autoFocus defaultValue="" onChange={ev => addExtraSku(ev.target.value)}
                  className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]">
                  <option value="">Select a product to add...</option>
                  {available.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <button onClick={() => setAddSkuOpen(true)}
                  className="w-full border border-dashed border-[var(--bg-input)] text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-xl py-3 text-sm transition-colors">
                  + Add another product
                </button>
              )
            })()}
          </div>
          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            <button onClick={submitComplete} disabled={completing || !completeFormValid()}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors">
              {completing ? <Loader2 size={16} className="animate-spin" /> : 'Confirm Delivery'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
