import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Calendar, ChevronDown, Package, Zap, Gauge, Lock, Unlock, Save, Loader2, Navigation, CheckCircle, Circle, X } from 'lucide-react'

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

function nnRoute(depotId, storeIds, cost) {
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

function routeCost(depotId, route, cost) {
  let total = 0
  let prev = depotId
  for (const id of route) { total += cost(prev, id); prev = id }
  total += cost(prev, depotId)
  return total
}

function twoOpt(depotId, route, cost) {
  let improved = true
  let best = [...route]
  let bestCost = routeCost(depotId, best, cost)
  while (improved) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)]
        const candidateCost = routeCost(depotId, candidate, cost)
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

function buildSequence(depotId, stopsInfo, cost) {
  const lockedStops = stopsInfo.filter(s => s.locked)
  const unlockedStops = stopsInfo.filter(s => !s.locked)
  const unlockedIds = unlockedStops.map(s => s.store_id)

  let orderedUnlocked = []
  if (unlockedIds.length > 0) {
    const seed = nnRoute(depotId, unlockedIds, cost)
    orderedUnlocked = twoOpt(depotId, seed, cost).route
  }

  const finalOrder = new Array(stopsInfo.length).fill(null)
  lockedStops.sort((a, b) => a.origIndex - b.origIndex).forEach(s => { finalOrder[s.origIndex] = s.store_id })

  let ui = 0
  for (let i = 0; i < finalOrder.length; i++) {
    if (finalOrder[i] === null) { finalOrder[i] = orderedUnlocked[ui]; ui++ }
  }
  return finalOrder
}

function buildMapsLinks(depot, orderedStoreObjs) {
  const points = orderedStoreObjs.filter(s => s.lat && s.lng)
  if (points.length === 0) return []
  const chunks = []
  for (let i = 0; i < points.length; i += MAPS_CHUNK_SIZE) {
    chunks.push(points.slice(i, i + MAPS_CHUNK_SIZE))
  }
  return chunks.map((chunk, idx) => {
    const origin = idx === 0 ? `${depot.lat},${depot.lng}` : `${chunks[idx - 1].slice(-1)[0].lat},${chunks[idx - 1].slice(-1)[0].lng}`
    const isLast = idx === chunks.length - 1
    const destinationStop = chunk[chunk.length - 1]
    const destination = isLast ? `${depot.lat},${depot.lng}` : `${destinationStop.lat},${destinationStop.lng}`
    const waypointStops = isLast ? chunk : chunk.slice(0, -1)
    const waypoints = waypointStops.map(s => `${s.lat},${s.lng}`).join('|')
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ''}&travelmode=driving`
    return { label: chunks.length > 1 ? `Leg ${idx + 1} (stops ${idx * MAPS_CHUNK_SIZE + 1}-${idx * MAPS_CHUNK_SIZE + chunk.length})` : 'Open in Google Maps', url }
  })
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
  const [priorLines, setPriorLines] = useState({})   // sku_id -> earlier delivery lines
  const [allSkus, setAllSkus] = useState([])
  const [extraReqs, setExtraReqs] = useState([])     // impulse-added SKUs
  const [addSkuOpen, setAddSkuOpen] = useState(false)
  const [locked, setLocked] = useState({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [completedStopIds, setCompletedStopIds] = useState(new Set())
  const [activeCompleteStop, setActiveCompleteStop] = useState(null)
  const [completeForm, setCompleteForm] = useState({})
  const [completing, setCompleting] = useState(false)
  const [batches, setBatches] = useState([])

  async function loadDates() {
    const { data } = await supabase.from('plans').select('plan_date').order('plan_date', { ascending: false }).limit(30)
    setDates([...new Set((data || []).map(d => d.plan_date))])
  }

  async function loadBatches() {
    const { data } = await supabase.from('production_batches')
      .select('id, sku_id, produced_on, expires_on, qty')
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
    if (!plan) { setStops([]); setOrder([]); setLoading(false); return }

    const { data } = await supabase
      .from('plan_stops')
      .select('id, stop_order, store_id, locked, stores(id, name), requirements(id, sku_id, proposed_qty, approved_qty, skus(name, shelf_life_days))')
      .eq('plan_id', plan.id)
      .order('stop_order')

    const withReqs = (data || []).filter(s => s.requirements && s.requirements.length > 0)
    setStops(withReqs)
    const lockMap = {}
    withReqs.forEach(s => { lockMap[s.store_id] = s.locked })
    setLocked(lockMap)
    setOrder(withReqs.map(s => s.store_id))

    // Check which stops already have delivery_lines (completed)
    const stopIds = withReqs.map(s => s.id)
    if (stopIds.length > 0) {
      const { data: existingDL } = await supabase.from('delivery_lines').select('plan_stop_id').in('plan_stop_id', stopIds)
      setCompletedStopIds(new Set((existingDL || []).map(d => d.plan_stop_id)))
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

  function optimize(useMetric) {
    if (!depot?.id || stops.length === 0) return
    const inputStops = stops.map((s, idx) => ({ store_id: s.store_id, locked: !!locked[s.store_id], origIndex: idx }))
    const newOrder = buildSequence(depot.id, inputStops, (a, b) => cost(a, b, useMetric))
    setOrder(newOrder)
    setMetric(useMetric)
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
      }
    })
    setCompleteForm(initial)
    setExtraReqs([])
    setAddSkuOpen(false)
    setActiveCompleteStop(stop)

    const [{ data: skus }, { data: prior }] = await Promise.all([
      supabase.from('skus').select('id, name').order('name'),
      supabase.from('delivery_lines')
        .select('id, sku_id, qty_delivered, delivered_on, production_batches(produced_on), returns(qty_returned), plan_stops!inner(store_id)')
        .eq('plan_stops.store_id', stop.store_id)
        .order('delivered_on', { ascending: false })
        .limit(80),
    ])
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

  const orderedStoreObjs = orderedStops.map(s => ({ id: s.store_id, ...storeCoords[s.store_id] }))
  const mapsLinks = depot ? buildMapsLinks(depot, orderedStoreObjs) : []
  const completedCount = orderedStops.filter(s => completedStopIds.has(s.id)).length

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
        <Calendar size={15} className="text-[var(--text-accent)]" />
        <div className="relative flex-1">
          <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
            className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] text-sm rounded-lg px-3 py-2 outline-none appearance-none">
            <option value={today()}>{today()} (today)</option>
            {dates.filter(d => d !== today()).map(d => <option key={d} value={d}>{d}</option>)}
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
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
            <button onClick={() => optimize('seconds')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${metric === 'seconds' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
              <Zap size={13} /> Fastest
            </button>
            <button onClick={() => optimize('meters')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${metric === 'meters' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
              <Gauge size={13} /> Shortest
            </button>
          </div>
          <div className="px-4 py-2 bg-[var(--bg-root)] border-b border-[var(--bg-card)] flex items-center justify-between text-xs text-[var(--text-muted)] shrink-0">
            <span>{Math.round(totalSeconds / 60)} min drive · {(totalMeters / 1000).toFixed(1)} km · {completedCount}/{orderedStops.length} done</span>
            <button onClick={saveOrder} disabled={saving} className="flex items-center gap-1 text-[var(--text-accent)] hover:text-[var(--text-accent2)] disabled:opacity-50">
              {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <span className="text-[var(--accent)]">Saved!</span> : <><Save size={13} /> Save order</>}
            </button>
          </div>
          {mapsLinks.length > 0 && (
            <div className="px-4 py-3 border-b border-[var(--bg-input)] flex flex-col gap-2 shrink-0">
              {mapsLinks.map((link, i) => (
                <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium rounded-lg py-2.5 transition-colors">
                  <Navigation size={15} /> {link.label}
                </a>
              ))}
            </div>
          )}
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
          <div className="bg-[var(--bg-card)]/60 rounded-xl p-3 text-[var(--text-muted)] text-xs flex items-center gap-2">
            <span className="text-[var(--text-gold)]">●</span> Start: Depot (9:00 AM)
          </div>
        )}
        {orderedStops.map((stop, idx) => {
          const isDone = completedStopIds.has(stop.id)
          return (
            <div key={stop.id} className={`bg-[var(--bg-card)] rounded-xl p-4 ${isDone ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <button onClick={() => toggleLock(stop.store_id)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0">
                    {locked[stop.store_id] ? <Lock size={13} className="text-[var(--text-gold)]" /> : <Unlock size={13} />}
                  </button>
                  <span className="text-[var(--text-primary)] text-sm font-medium truncate">{idx + 1}. {stop.stores?.name}</span>
                </div>
                <span className="text-[var(--text-muted2)] text-xs shrink-0">ETA {formatEta(legInfo[idx]?.eta || 0)}</span>
              </div>
              <div className="text-[var(--text-muted2)] text-xs pl-5 mb-1">
                +{Math.round(legInfo[idx]?.legMinutes || 0)} min · {(legInfo[idx]?.legKm || 0).toFixed(1)} km from previous
              </div>
              {stop.requirements?.map(req => (
                <div key={req.id} className="text-[var(--text-muted)] text-xs flex justify-between pl-5">
                  <span>{req.skus?.name}</span>
                  <span className="text-[var(--text-secondary)]">{req.approved_qty ?? req.proposed_qty} pcs</span>
                </div>
              ))}
              <div className="pl-5 mt-2">
                {isDone ? (
                  <span className="flex items-center gap-1.5 text-[var(--accent)] text-xs">
                    <CheckCircle size={14} /> Delivered
                  </span>
                ) : (
                  <button onClick={() => openCompleteForm(stop)}
                    className="flex items-center gap-1.5 text-[var(--text-accent)] hover:text-[var(--text-accent2)] text-xs font-medium">
                    <Circle size={14} /> Mark delivered
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {activeCompleteStop && (
        <div className="absolute inset-0 bg-[var(--bg-root)]/95 flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
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
              const needsReturnLine = Number(line.qty_returned) > 0 && !line.return_line_id
              const req = { sku_id: row.sku_id }
              return (
                <div key={row.key} className="bg-[var(--bg-card)] rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[var(--text-primary)] text-sm font-medium">{row.name}{row.extra && <span className="text-[var(--text-gold)] text-xs ml-2">trial</span>}</span>
                    {row.extra && <button onClick={() => removeExtraSku(row.sku_id)} className="text-[var(--text-muted2)] hover:text-red-400"><X size={14} /></button>}
                  </div>
                  <div className="mb-3">
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Production batch {needsBatch && <span className="text-red-400">*</span>}</label>
                    <select value={line.batch_id || ''}
                      onChange={e => setCompleteForm(f => ({ ...f, [req.sku_id]: { ...f[req.sku_id], batch_id: e.target.value } }))}
                      className={`w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 ${needsBatch ? 'ring-2 ring-red-500' : 'focus:ring-[var(--accent)]'}`}>
                      <option value="">Select batch...</option>
                      {skuBatches.map(b => (
                        <option key={b.id} value={b.id}>{b.produced_on} · expires {b.expires_on} · {b.qty} pcs</option>
                      ))}
                    </select>
                    {skuBatches.length === 0 && <p className="text-[var(--text-gold)] text-xs mt-1">⚠ No active batches for this product</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
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
