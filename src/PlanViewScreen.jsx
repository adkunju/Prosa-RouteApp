import React, { useEffect, useState, useRef } from 'react'
import { supabase } from './supabaseClient'
import QuickDeliverModal from './QuickDeliverModal'
import AddStoreModal from './AddStoreModal'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import { Calendar, ChevronDown, Package, Zap, Gauge, Lock, Unlock, Save, Loader2, Navigation, CheckCircle, Circle, X, GripVertical, ChevronRight, ClipboardCheck } from 'lucide-react'
import ProspectVisitModal from './ProspectVisitModal'
import { useSettings } from './useSettings'
import { computeProposedQty } from './forecastMath'

const today = () => new Date().toLocaleDateString('en-CA')
// START_HOUR replaced by settings.route_start_time
const MAPS_CHUNK_SIZE = 8

function formatEta(minutesFromStart, startMinutes) {
  const totalMin = (startMinutes ?? 9 * 60) + minutesFromStart
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
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [all, setAll] = useState([])
  const [prospects, setProspects] = useState([])
  const [forecast, setForecast] = useState({})
  const [matrix, setMatrix] = useState({})
  const [depot, setDepot] = useState(null)
  const [preview, setPreview] = useState(null)
  const [adding, setAdding] = useState(false)
  const [prospectAdded, setProspectAdded] = useState(new Set())
  const [visitDate, setVisitDate] = useState(selectedDate || new Date().toLocaleDateString('en-CA'))

  useEffect(() => { (async () => {
    const [{ data: st }, { data: pr }, { data: fc }, { data: mx }, { data: dep }] = await Promise.all([
      supabase.from('stores').select('id,name,pipeline_status').eq('is_active',true).eq('is_depot',false).eq('exclude_from_forecast',false).order('name'),
      supabase.from('stores').select('id,name,pipeline_status').eq('is_active',true).eq('is_depot',false).not('pipeline_status','in','("onboard","dropped")').order('name'),
      supabase.from('store_sales_summary').select('store_id,visit_count,revenue,last_visit,days_since_visit'),
      supabase.from('travel_matrix').select('from_store_id,to_store_id,seconds'),
      supabase.from('stores').select('id').eq('is_depot',true).maybeSingle(),
    ])
    const fcMap = {}
    ;(fc||[]).forEach(r => { fcMap[r.store_id] = r })
    const mxMap = {}
    ;(mx||[]).forEach(r => { mxMap[`${r.from_store_id}_${r.to_store_id}`] = r.seconds })
    const todayIds = new Set(stops.map(s => s.store_id))
    setAll((st||[]).filter(s => !todayIds.has(s.id)))
    setProspects((pr||[]).filter(s => !todayIds.has(s.id)).map(s => ({ ...s, ...fcMap[s.id] })).sort((a,b) => (b.days_since_visit??9999)-(a.days_since_visit??9999)))
    setForecast(fcMap)
    setMatrix(mxMap)
    setDepot(dep)
  })() }, [])

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

  function timeImpact(storeId) {
    const seq = [depot?.id, ...stops.map(s => s.store_id), depot?.id].filter(Boolean)
    if (seq.length < 2) return null
    let minCost = Infinity
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i+1]
      const to = matrix[`${a}_${storeId}`] ?? matrix[`${storeId}_${a}`]
      const from = matrix[`${storeId}_${b}`] ?? matrix[`${b}_${storeId}`]
      const existing = matrix[`${a}_${b}`] ?? matrix[`${b}_${a}`]
      if (to != null && from != null && existing != null) minCost = Math.min(minCost, to + from - existing)
    }
    return minCost === Infinity ? null : Math.round(Math.max(0, minCost) / 60)
  }

  const qLower = q.toLowerCase()
  const allMatches = q.length > 1 ? all.filter(s => _tokenMatch(q, s.name)).slice(0,10) : all.slice(0,10)
  const prospectMatches = q.length > 1 ? prospects.filter(s => _tokenMatch(q, s.name)) : prospects

  async function confirmAdd() {
    if (!preview || adding) return
    setAdding(true)
    const { pos } = getBestPos(preview.id)
    const insertOrder = pos + 1
    const toShift = stops.filter(s => s.stop_order >= insertOrder).sort((a,b) => b.stop_order - a.stop_order)
    for (const s of toShift) await supabase.from('plan_stops').update({ stop_order: s.stop_order + 1 }).eq('id', s.id)
    await supabase.from('plan_stops').insert({ plan_id: planId, store_id: preview.id, stop_order: insertOrder })
    setAdding(false)
    onAdded()
  }

  async function addProspect(store) {
    if (adding) return
    setAdding(store.id)
    const { data: plan } = await supabase.from('plans').select('id').eq('plan_date', visitDate).maybeSingle()
    const targetPlanId = plan?.id || planId
    const { data: existingStops } = await supabase.from('plan_stops').select('stop_order').eq('plan_id', targetPlanId).order('stop_order', { ascending: false }).limit(1)
    const maxOrder = existingStops?.[0]?.stop_order || 0
    await supabase.from('plan_stops').insert({ plan_id: targetPlanId, store_id: store.id, stop_order: maxOrder + 1 })
    setAdding(null)
    setProspectAdded(a => new Set([...a, store.id]))
    onAdded()
  }

  async function removeProspect(store) {
    const { data: plan } = await supabase.from('plans').select('id').eq('plan_date', visitDate).maybeSingle()
    if (!plan) return
    await supabase.from('plan_stops').delete().eq('plan_id', plan.id).eq('store_id', store.id)
    setProspectAdded(a => { const n = new Set(a); n.delete(store.id); return n })
    onAdded()
  }

  const statusColor = {
    prospect: 'text-[var(--accent)] bg-[var(--accent)]/10',
    warm: 'text-[var(--text-gold)] bg-[var(--text-gold)]/10',
    cold: 'text-[var(--text-muted2)] bg-[var(--bg-input)]',
    dormant: 'text-red-400 bg-red-400/10',
  }

  if (preview) {
    const fc = forecast[preview.id]
    const { pos, addedMin } = getBestPos(preview.id)
    const afterStop = (pos > 0 && stops[pos - 1]?.stores?.name) ? stops[pos - 1].stores.name : 'Depot'
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-[var(--bg-card)]/80 border border-[var(--accent)]/30 rounded-xl p-4">
          <div className="text-[var(--text-primary)] text-sm font-semibold mb-1">{preview.name}</div>
          <div className="text-[var(--text-muted2)] text-xs mb-2">Inserts after <span className="text-[var(--text-secondary)]">{afterStop}</span> · adds ~{addedMin} min</div>
          {fc && fc.visit_count > 0 ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[var(--bg-input)]/50 rounded-lg p-2"><div className="text-[var(--text-muted2)]">Last delivery</div><div className="text-[var(--text-secondary)]">{fc.days_since_visit}d ago</div></div>
              <div className="bg-[var(--bg-input)]/50 rounded-lg p-2"><div className="text-[var(--text-muted2)]">Total revenue</div><div className="text-[var(--text-secondary)]">₹{Number(fc.revenue).toLocaleString('en-IN',{maximumFractionDigits:0})}</div></div>
            </div>
          ) : <div className="text-[var(--text-gold)] text-xs">No delivery history — new store</div>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setPreview(null)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3 py-2">Back</button>
          <button onClick={confirmAdd} disabled={adding} className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-semibold rounded-xl py-2.5 transition-colors">
            {adding ? 'Adding...' : 'Add to route'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex rounded-xl overflow-hidden border border-[var(--bg-hover)] mb-3">
        <button onClick={() => setTab('all')} className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'all' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>All stores</button>
        <button onClick={() => setTab('prospects')} className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === 'prospects' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>🤝 Prospects</button>
      </div>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search stores..."
        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />
      {tab === 'all' && (
        <>
          {!q && <p className="text-[var(--text-muted2)] text-xs mb-2">Stores not on today's route · sorted by days since last visit</p>}
          {allMatches.map(s => {
            const fc = forecast[s.id]
            return (
              <button key={s.id} onClick={() => setPreview(s)} className="w-full text-left bg-[var(--bg-card)]/70 hover:bg-[var(--bg-input)]/60 rounded-xl px-4 py-3 mb-1.5 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--text-secondary)] text-sm">{s.name}</span>
                  {s.pipeline_status && s.pipeline_status !== 'onboard' && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${statusColor[s.pipeline_status] || 'text-[var(--text-muted2)] bg-[var(--bg-input)]'}`}>{s.pipeline_status}</span>
                  )}
                </div>
                {fc && fc.visit_count > 0 ? <div className="text-[var(--text-muted2)] text-xs mt-0.5">{fc.days_since_visit}d since last delivery · ₹{Number(fc.revenue).toLocaleString('en-IN',{maximumFractionDigits:0})} total</div>
                  : <div className="text-[var(--text-gold)] text-xs mt-0.5">No delivery history</div>}
              </button>
            )
          })}
        </>
      )}
      {tab === 'prospects' && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[var(--text-muted)] text-xs shrink-0">Visit date</span>
            <input type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)}
              className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] text-xs rounded-lg px-3 py-1.5 outline-none" />
          </div>
          {prospectMatches.length === 0 && <p className="text-[var(--text-muted2)] text-sm text-center mt-8">No prospects match</p>}
          {prospectMatches.map(s => {
            const isAdded = prospectAdded.has(s.id)
            const impact = timeImpact(s.id)
            return (
              <div key={s.id} className={`bg-[var(--bg-card)] rounded-xl p-3 flex items-center gap-3 mb-1.5 ${isAdded ? 'opacity-70' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${statusColor[s.pipeline_status] || 'text-[var(--text-muted2)] bg-[var(--bg-input)]'}`}>{s.pipeline_status}</span>
                  </div>
                  <div className="text-[var(--text-muted2)] text-xs flex items-center gap-1.5">
                    {s.days_since_visit != null ? <span>{s.days_since_visit}d since last visit</span> : <span className="text-[var(--text-gold)]">Never visited</span>}
                    {impact != null && <span className="bg-[var(--bg-input)] px-1.5 py-0.5 rounded">+{impact}m</span>}
                  </div>
                </div>
                {isAdded
                  ? <button onClick={() => removeProspect(s)} className="shrink-0 bg-[var(--bg-input)] text-red-400 text-xs font-semibold rounded-xl px-3 py-2 hover:bg-red-400/20">Remove</button>
                  : <button onClick={() => addProspect(s)} disabled={adding === s.id} className="shrink-0 bg-[var(--accent)] disabled:opacity-50 text-white text-xs font-semibold rounded-xl px-3 py-2 hover:opacity-90">{adding === s.id ? '...' : '+ Add'}</button>
                }
              </div>
            )
          })}
        </>
      )}
    </>
  )
}


function MapsCard({ links, compact }) {
  if (compact) {
    const [open, setOpen] = React.useState(false)
    return (
      <div className="flex-1 relative">
        <button onClick={() => setOpen(v => !v)}
          className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-input)] transition-colors">
          <Navigation size={11} /> Maps {open ? '▲' : '▼'}
        </button>
        {open && (
          <div className="absolute top-full left-0 right-0 z-10 flex flex-col gap-1 mt-1 bg-[var(--bg-card)] rounded-xl p-2 shadow-xl border border-[var(--bg-input)]">
            {links.map((link, i) => (
              <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-input)] transition-colors">
                <Navigation size={11} /> {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
    )
  }
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


// Token-based fuzzy match: each space-separated token must appear in name
function _tokenMatch(q, name) {
  const t = (q || '').trim().toLowerCase()
  if (!t) return true
  const n = (name || '').toLowerCase()
  return t.split(/\s+/).filter(Boolean).every(x => n.includes(x))
}

// Batch stock left = produced - delivered - adjusted (self consumed, damaged, ...)
function batchAvail(b) {
  const delivered = (b.delivery_lines || []).reduce((n, l) => n + (l.qty_delivered || 0), 0)
  const adjusted = (b.stock_adjustments || []).reduce((n, a) => n + (a.qty || 0), 0)
  return b.qty - delivered - adjusted
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
  const [pickupDueToday, setPickupDueToday] = useState([])
  const [pickupModalStore, setPickupModalStore] = useState(null)
  const [skippedPickupStoreIds, setSkippedPickupStoreIds] = useState(new Set())
  const [pickupSectionOpen, setPickupSectionOpen] = useState(false)
  const [skippedStopIds, setSkippedStopIds] = useState(new Set())
  const [activeCompleteStop, setActiveCompleteStop] = useState(null)
  const [completeForm, setCompleteForm] = useState({})
  const [completing, setCompleting] = useState(false)
  const [batches, setBatches] = useState([])
  const [useLiveOrigin, setUseLiveOrigin] = useState(false)
  const [liveCoords, setLiveCoords] = useState(null)
  const [prospectOpen, setProspectOpen] = useState(false)
  const [showDelivered, setShowDelivered] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const { settings } = useSettings()

  const effectiveStartMinutes = (() => {
    const [sh, sm] = (settings.route_start_time || '09:00').split(':').map(Number)
    const settingsMin = sh * 60 + sm
    if (selectedDate === today()) {
      const now = new Date()
      const nowMin = now.getHours() * 60 + now.getMinutes()
      return nowMin > settingsMin ? nowMin : settingsMin
    }
    return settingsMin
  })()

  async function loadDates() {
    // Only plans that have stops, sorted oldest-first so the dropdown reads
    // chronologically. Auto-select the nearest upcoming (or most recent) date.
    const { data } = await supabase
      .from('plans')
      .select('plan_date, plan_stops(id)')
      .gte('plan_date', new Date().toISOString().slice(0, 10))
      .order('plan_date', { ascending: true })
      .limit(14)
    const todayStr = new Date().toLocaleDateString('en-CA')
    const withStops = [...new Set(
      (data || []).filter(d => (d.plan_stops?.length ?? 0) > 0).map(d => d.plan_date)
    )].filter(d => d >= todayStr).sort()
    setDates(withStops)
    if (withStops.length > 0) {
      const upcoming = withStops.find(d => d >= todayStr) || withStops[0]
      setSelectedDate(upcoming)
    }
  }

  async function loadBatches() {
    const { data } = await supabase.from('production_batches')
      .select('id, sku_id, produced_on, expires_on, qty, delivery_lines(qty_delivered), stock_adjustments(qty)')
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
      .select('id, stop_order, store_id, locked, stores(id, name, pipeline_status, place_id, lat, lng), requirements(id, sku_id, proposed_qty, approved_qty, skus(name, shelf_life_days, min_delivery_qty))')
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

    // Load depot pickups due on/before this date
    const [{ data: forecast }, { data: pickupStores }, { data: pickupDeliveredToday }, { data: pickupOverrides }] = await Promise.all([
      supabase.from('store_sku_forecast').select('*').neq('pipeline_status', 'dropped'),
      supabase.from('stores').select('id, name, is_pickup, is_active').eq('is_pickup', true).eq('is_active', true),
      supabase.from('delivery_lines').select('store_id').eq('delivered_on', date).is('plan_stop_id', null),
      supabase.from('pickup_allocations').select('store_id, sku_id, qty'),
    ])
    const pickupOverrideMap = {}
    ;(pickupOverrides || []).forEach(o => { pickupOverrideMap[`${o.store_id}_${o.sku_id}`] = o.qty })
    const pickupStoreIds = new Set((pickupStores || []).map(s => s.id))
    const deliveredPickupToday = new Set((pickupDeliveredToday || []).filter(d => pickupStoreIds.has(d.store_id)).map(d => d.store_id))
    const pickupRows = (forecast || []).filter(r =>
      pickupStoreIds.has(r.store_id) && r.next_visit_due && (
        deliveredPickupToday.has(r.store_id) ||
        (new Date(r.next_visit_due) - new Date(date)) / 86400000 <= 3
      )
    )
    const byPickupStore = {}
    pickupRows.forEach(r => {
      if (!byPickupStore[r.store_id]) {
        byPickupStore[r.store_id] = { store_id: r.store_id, name: r.store_name, due_date: r.next_visit_due, skuReqs: [] }
      }
      const overrideKey = `${r.store_id}_${r.sku_id}`
      const qty = pickupOverrideMap[overrideKey] !== undefined
        ? pickupOverrideMap[overrideKey]
        : computeProposedQty(r).proposed
      byPickupStore[r.store_id].skuReqs.push({ sku_id: r.sku_id, name: r.sku_name, qty })
      if (r.next_visit_due < byPickupStore[r.store_id].due_date) byPickupStore[r.store_id].due_date = r.next_visit_due
    })
    setPickupDueToday(Object.values(byPickupStore).filter(s => s.skuReqs.some(r => r.qty > 0)))

    // Re-hydrate pickup completions after reload so cards remember their state
    if (deliveredPickupToday.size > 0) {
      setCompletedStopIds(prev => {
        const next = new Set(prev)
        deliveredPickupToday.forEach(sid => next.add(`pickup-${sid}`))
        return next
      })
    }

    setLoading(false)
  }

  const [stateRestored, setStateRestored] = React.useState(false)

  // Restore ephemeral delivery state (skipped stops, extra SKUs, metric) from sessionStorage
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('prosa_delivery_state')
      if (raw) {
        const s = JSON.parse(raw)
        if (s.selectedDate) setSelectedDate(s.selectedDate)
        if (s.metric) setMetric(s.metric)
        if (s.skippedStopIds) setSkippedStopIds(new Set(s.skippedStopIds))
        if (s.extraReqs) setExtraReqs(s.extraReqs)
      }
    } catch {}
    setStateRestored(true)
  }, [])

  useEffect(() => { loadDates(); loadMatrix(); loadBatches() }, [])
  useEffect(() => {
    const fn = () => loadBatches()
    window.addEventListener('prosa:stock_changed', fn)
    return () => window.removeEventListener('prosa:stock_changed', fn)
  }, [])
  useEffect(() => { loadPlan(selectedDate) }, [selectedDate])

  useEffect(() => {
    if (stops.length > 0 && depot?.id && Object.keys(matrixSeconds).length > 0) {
      optimize('seconds')
    }
    // eslint-disable-next-line
  }, [stops, depot, matrixSeconds])

  // Persist ephemeral delivery state so tab switches don't reset it
  // Guard with stateRestored so we don't overwrite saved state before restore runs
  useEffect(() => {
    if (!stateRestored) return
    try {
      sessionStorage.setItem('prosa_delivery_state', JSON.stringify({
        selectedDate,
        metric,
        skippedStopIds: [...skippedStopIds],
        extraReqs,
      }))
    } catch {}
  }, [stateRestored, selectedDate, metric, skippedStopIds, extraReqs])

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
    // Find nearest cached waypoint to driver's live position (used by costFn for accurate first-leg estimation)
    let liveNearestId = null
    let liveNearestSec = 0
    if (originId === LIVE_ID) {
      let best = Infinity
      const candidates = [...stops.map(s => s.store_id), depot.id]
      for (const sid of candidates) {
        const sc = storeCoords[sid]
        if (!sc) continue
        const d = haversineSec(live.lat, live.lng, sc.lat, sc.lng)
        if (d < best) { best = d; liveNearestId = sid }
      }
      liveNearestSec = best === Infinity ? 0 : best
    }
    const inputStops = stops.map((s, idx) => ({ store_id: s.store_id, locked: !!locked[s.store_id], origIndex: idx }))
    const costFn = (a, b) => {
      if (b === LIVE_ID) {
        // Closing edge — driver ends at depot, not back at their current location
        return cost(a, depot.id, useMetric)
      }
      if (a === LIVE_ID) {
        // Opening edge — driver's current position to first stop (haversine)
        const sc = storeCoords[b]
        if (!sc || !live) return 99999
        return haversineSec(live.lat, live.lng, sc.lat, sc.lng)
      }
      return cost(a, b, useMetric)
    }
    const closeLoop = true
    const newOrder = buildSequence(originId, inputStops, costFn, closeLoop)
    setOrder(newOrder)
    setMetric(useMetric)
  }

  function toggleLiveOrigin() {
    const next = !useLiveOrigin
    setUseLiveOrigin(next)
    try { localStorage.setItem('prosa_use_live_origin', next ? '1' : '0') } catch {}
    if (next) {
      navigator.geolocation?.getCurrentPosition(
        pos => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
          setLiveCoords(coords)
          optimize(metric, coords, true)
        },
        () => { setUseLiveOrigin(false); try { localStorage.setItem('prosa_use_live_origin', '0') } catch {}; alert('Could not get your location.') },
        { enableHighAccuracy: true, timeout: 8000 }
      )
    } else {
      setLiveCoords(null)
      optimize(metric, null, false)
    }
  }

  function refreshLocation() {
    if (!useLiveOrigin) return
    navigator.geolocation?.getCurrentPosition(
      pos => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setLiveCoords(coords)
        optimize(metric, coords, true)
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    )
  }

  // Fires immediately when Live turns on (via toggle or restore), then every 2.5 min
  useEffect(() => {
    if (!useLiveOrigin) return
    refreshLocation()
    const id = setInterval(() => { refreshLocation() }, 150000)
    return () => clearInterval(id)
    // eslint-disable-next-line
  }, [useLiveOrigin])

  // Restore Live origin toggle from localStorage on mount (persists across app reopens)
  useEffect(() => {
    try {
      if (localStorage.getItem('prosa_use_live_origin') === '1') {
        setUseLiveOrigin(true)
      }
    } catch {}
  }, [])

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
    return batches.filter(b => {
      if (b.sku_id !== skuId) return false
      if (b.expires_on < today()) return false
      return batchAvail(b) > 0
    })
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
        .select('id, sku_id, qty_delivered, delivered_on, unit_price, is_offer, production_batches(produced_on), returns(qty_returned)')
        .eq('store_id', stop.store_id)
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
    // distinguishable from forecast-generated rows. Pickups have no plan_stop,
    // so extras there just insert straight into delivery_lines below.
    if (!activeCompleteStop.is_pickup) {
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
    }

    const rows = [
      ...activeCompleteStop.requirements.map(r => ({ sku_id: r.sku_id })),
      ...extraReqs.map(e => ({ sku_id: e.sku_id })),
    ]

    for (const req of rows) {
      const line = completeForm[req.sku_id]
      if (!line) continue
      await supabase.from('delivery_lines').insert({
        plan_stop_id: activeCompleteStop.is_pickup ? null : activeCompleteStop.id,
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
  const scrollRef = useRef(null)
  const scrollRafRef = useRef(null)

  // Pointer events rather than HTML5 drag-and-drop, which never fires on
  // mobile browsers — where this list is actually used.
  function startDrag(e, idx) {
    e.preventDefault()
    setDragIdx(idx)
    setOverIdx(idx)
    let target = idx
    let lastY = e.clientY
    let accY = 0
    const move = ev => {
      const pt = ev.touches ? ev.touches[0] : ev
      const delta = pt.clientY - lastY
      lastY = pt.clientY
      accY += delta
      setDragY(accY)
      const el = document.elementFromPoint(pt.clientX, pt.clientY)
      const row = el && el.closest('[data-stop-idx]')
      if (row) { target = Number(row.getAttribute('data-stop-idx')); setOverIdx(target) }
      // Auto-scroll when near edges
      const container = scrollRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const ZONE = 80
        const MAX_SPEED = 12
        cancelAnimationFrame(scrollRafRef.current)
        const y = pt.clientY
        let speed = 0
        if (y < rect.top + ZONE) speed = -MAX_SPEED * (1 - (y - rect.top) / ZONE)
        else if (y > rect.bottom - ZONE) speed = MAX_SPEED * (1 - (rect.bottom - y) / ZONE)
        if (speed !== 0) {
          const scroll = () => {
            container.scrollTop += speed
            accY += speed
            setDragY(accY)
            scrollRafRef.current = requestAnimationFrame(scroll)
          }
          scrollRafRef.current = requestAnimationFrame(scroll)
        }
      }
    }
    const end = () => {
      cancelAnimationFrame(scrollRafRef.current)
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

  // Only count remaining active stops (not skipped, not completed) for live stats
  const remainingOrder = order.filter(id => {
    const stop = stops.find(s => s.store_id === id)
    return stop && !skippedStopIds.has(stop.id) && !completedStopIds.has(stop.id)
  })
  const totalSeconds = depot?.id ? routeCost(depot.id, remainingOrder, (a, b) => cost(a, b, 'seconds'), false) : 0
  const totalMeters = depot?.id ? routeCost(depot.id, remainingOrder, (a, b) => cost(a, b, 'meters'), false) : 0

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
      <div className="px-3 py-1.5 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
        <Calendar size={13} className="text-[var(--text-accent)] shrink-0" />
        <div className="relative shrink-0">
          <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
            className="bg-transparent text-[var(--text-primary)] text-xs font-medium outline-none appearance-none pr-4">
            {dates.map(d => <option key={d} value={d}>{d}{d === today() ? ' (today)' : ''}</option>)}
          </select>
          <ChevronDown size={11} className="absolute right-0 top-0.5 text-[var(--text-muted)] pointer-events-none" />
        </div>
        <span className="text-[var(--text-muted2)] text-xs flex-1 truncate">{Math.round(totalSeconds / 60)}m · {(totalMeters / 1000).toFixed(1)}km · {completedCount}/{orderedStops.length}</span>
      </div>

      {stops.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--bg-input)] flex gap-2 shrink-0">
          <button onClick={() => optimize(metric === 'seconds' ? 'meters' : 'seconds')}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-input)] transition-colors">
            {metric === 'seconds'
              ? <><Zap size={11} className="text-[var(--accent)]" /> Fastest</>
              : <><Gauge size={11} className="text-[var(--accent)]" /> Shortest</>}
          </button>
          {mapsLinks.length > 0 && (
            mapsLinks.length === 1
              ? <a href={mapsLinks[0].url} target="_blank" rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-input)] transition-colors">
                  <Navigation size={11} /> Maps
                </a>
              : <MapsCard links={mapsLinks} compact />
          )}
          <button onClick={() => setAddStopOpen(true)}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-input)] transition-colors">
            + Add
          </button>
          <button onClick={saveOrder} disabled={saving}
            className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-input)] disabled:opacity-50 transition-colors shrink-0">
            {saving ? <Loader2 size={11} className="animate-spin" /> : saved ? <><CheckCircle size={11} className="text-[var(--accent)]" /> Saved</> : <><Save size={11} /> Save</>}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Loading...</div>}
        {!loading && stops.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No plan for this date</p>
          </div>
        )}
        {!loading && pickupDueToday.length > 0 && (() => {
          const activePickups = pickupDueToday.filter(s => !skippedPickupStoreIds.has(s.store_id) && !completedStopIds.has(`pickup-${s.store_id}`))
          const donePickups = pickupDueToday.filter(s => completedStopIds.has(`pickup-${s.store_id}`))
          return (
            <div className={`bg-[var(--bg-card)]/40 border border-[var(--text-gold)]/25 rounded-2xl p-3 mb-1 transition-opacity ${activePickups.length === 0 ? 'opacity-50' : ''}`}>
              <button onClick={() => setPickupSectionOpen(o => !o)}
                className="w-full flex items-center gap-1.5 text-left">
                <Package size={12} className="text-[var(--text-gold)]" />
                <span className="text-[var(--text-primary)] text-xs font-semibold">Depot pickups today</span>
                {activePickups.length > 0 && (
                  <span className="bg-[var(--text-gold)]/20 text-[var(--text-gold)] text-[10px] font-medium rounded-full px-1.5 py-0.5">{activePickups.length} pending</span>
                )}
                <span className="text-[var(--text-muted2)] text-[10px] ml-auto">{donePickups.length}/{pickupDueToday.length}</span>
                <ChevronDown size={12} className={`text-[var(--text-muted2)] transition-transform ${pickupSectionOpen ? 'rotate-180' : ''}`} />
              </button>
              <div className={`flex flex-col gap-1.5 overflow-hidden transition-all ${pickupSectionOpen ? 'mt-2 max-h-[1000px]' : 'max-h-0'}`}>
                {activePickups.map(s => (
                  <div key={s.store_id} className="bg-[var(--bg-input)]/40 rounded-lg px-2.5 py-2 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--text-secondary)] text-xs font-medium truncate">{s.name}</div>
                      <div className="text-[var(--text-muted2)] text-[10px] truncate">
                        {s.skuReqs.map(r => `${r.name.split('/')[0].trim()}: ${r.qty}`).join(' · ')}
                      </div>
                    </div>
                    <button onClick={() => {
                        const syntheticStop = {
                          id: `pickup-${s.store_id}`,
                          store_id: s.store_id,
                          stores: { name: s.name },
                          is_pickup: true,
                          requirements: s.skuReqs.map((r, i) => ({
                            id: `pickup-req-${s.store_id}-${r.sku_id}`,
                            sku_id: r.sku_id,
                            skus: { name: r.name },
                            approved_qty: r.qty,
                            proposed_qty: r.qty,
                          })),
                        }
                        openCompleteForm(syntheticStop)
                      }}
                      className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[10px] font-medium rounded-md px-2 py-1 flex items-center gap-1 shrink-0">
                      <ClipboardCheck size={11} /> Mark delivery
                    </button>
                    <button onClick={() => setSkippedPickupStoreIds(new Set([...skippedPickupStoreIds, s.store_id]))}
                      className="text-[var(--text-muted2)] hover:text-red-400 text-[10px] shrink-0">
                      Skip
                    </button>
                  </div>
                ))}
                {donePickups.map(s => (
                  <div key={s.store_id} className="bg-[var(--bg-input)]/20 rounded-lg px-2.5 py-1.5 flex items-center gap-2 opacity-60">
                    <CheckCircle size={12} className="text-[var(--accent)] shrink-0" />
                    <span className="text-[var(--text-muted)] text-xs truncate flex-1">{s.name}</span>
                    <span className="text-[var(--text-muted2)] text-[10px]">Collected</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {orderedStops.length > 0 && (
          <button onClick={toggleLiveOrigin}
            className="w-full bg-[var(--bg-card)]/60 rounded-xl p-3 text-xs flex items-center gap-2 hover:bg-[var(--bg-input)]/60 transition-colors">
            <span className={useLiveOrigin ? 'text-[var(--accent)]' : 'text-[var(--text-gold)]'}>●</span>
            <span className="text-[var(--text-muted)] flex-1 text-left">
              {(() => {
                const [sh, sm] = (settings.route_start_time || '09:00').split(':').map(Number)
                const h12 = sh % 12 === 0 ? 12 : sh % 12
                const ampm = sh >= 12 ? 'PM' : 'AM'
                const timeStr = `${h12}:${sm.toString().padStart(2,'0')} ${ampm}`
                const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
                const settMin = sh * 60 + sm
                const isLate = selectedDate === today() && nowMin > settMin
                return useLiveOrigin
                  ? `Start: Live location (${isLate ? 'Now' : timeStr})`
                  : `Start: Depot (${isLate ? 'Now' : timeStr})`
              })()}
            </span>
            <span className={`px-2 py-0.5 rounded-lg font-medium ${useLiveOrigin ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'bg-[var(--bg-input)] text-[var(--text-muted2)]'}`}>
              {useLiveOrigin ? '📍 Live' : '🏠 Depot'} · tap to switch
            </span>
          </button>
        )}
        {(() => {
          const activeStops = orderedStops.filter(s => !skippedStopIds.has(s.id) && !completedStopIds.has(s.id))
          const doneStops = orderedStops.filter(s => completedStopIds.has(s.id))
          const skippedStops = orderedStops.filter(s => skippedStopIds.has(s.id) && !completedStopIds.has(s.id))

          const renderCard = (stop, idx, draggable) => {
            const isDone = completedStopIds.has(stop.id)
            const isSkipped = skippedStopIds.has(stop.id)
            return (
              <div key={stop.id} data-stop-idx={draggable ? idx : undefined}
                style={draggable ? (() => {
                  if (dragIdx === idx) return { transform: `translateY(${dragY}px) scale(0.92)`, zIndex: 30, position: 'relative', opacity: 0.85, boxShadow: '0 8px 20px rgba(0,0,0,.35)', transition: 'none', pointerEvents: 'none' }
                  if (dragIdx === null || overIdx === null) return undefined
                  return undefined
                })() : undefined}
                className={`bg-[var(--bg-card)] rounded-xl p-4 ${isDone || isSkipped ? 'opacity-50' : ''} ${draggable && dragIdx === idx ? 'ring-2 ring-[var(--accent)]' : 'transition-transform duration-150'} ${draggable && dragIdx !== null && dragIdx !== idx ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {draggable && (
                      <span onPointerDown={e => startDrag(e, idx)}
                        className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0 cursor-grab active:cursor-grabbing touch-none">
                        <GripVertical size={14} className={dragIdx === idx ? 'text-[var(--accent)]' : ''} />
                      </span>
                    )}
                    <button onClick={() => toggleLock(stop.store_id)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0">
                      {locked[stop.store_id] ? <Lock size={13} className="text-[var(--text-gold)]" /> : <Unlock size={13} />}
                    </button>
                    <a href={stop.stores?.place_id ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.stores.name || "")}&query_place_id=${stop.stores.place_id}` : (stop.stores?.lat && stop.stores?.lng) ? `https://www.google.com/maps/search/?api=1&query=${stop.stores.lat},${stop.stores.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.stores?.name || '')}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} className="text-[var(--text-primary)] text-sm font-medium truncate hover:text-[var(--text-accent)] hover:underline">{stop.stores?.name}</a>
                    {stop.stores?.pipeline_status && stop.stores.pipeline_status !== 'onboard' && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 bg-[var(--accent)]/10 text-[var(--accent)]">
                        {stop.stores.pipeline_status}
                      </span>
                    )}
                    <ContactButtons phone={phones[stop.store_id]} />
                  </div>
                  <span className="text-[var(--text-muted2)] text-xs shrink-0">ETA {formatEta(legInfo[idx]?.eta || 0, effectiveStartMinutes)}</span>
                </div>
                {(legInfo[idx]?.legMinutes || 0) > 500 ? (
                  <div className="text-[var(--text-muted2)] text-xs pl-5 mb-1 italic">No route data · visit order estimated</div>
                ) : (
                  <div className="text-[var(--text-muted2)] text-xs pl-5 mb-1">
                    +{Math.round(legInfo[idx]?.legMinutes || 0)} min · {(legInfo[idx]?.legKm || 0).toFixed(1)} km from previous
                  </div>
                )}
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
                  {isSkipped ? (
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-[var(--text-muted2)] text-xs">Skipped</span>
                      <button onClick={() => toggleSkip(stop.id)} className="text-[var(--accent)] text-xs hover:opacity-80">Undo</button>
                    </div>
                  ) : isDone ? (
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-[var(--accent)] text-xs">
                        <CheckCircle size={14} /> Delivered
                      </span>
                      <button onClick={async () => {
                        // Deletions must catch BOTH plan-linked and quick-delivery rows
                        // for this store today, AND any returns entered during this visit
                        // (which may point to an older delivery_line if the pack expired
                        // stock came from an earlier drop).
                        const dateStr = selectedDate
                        const { data: dls } = await supabase.from('delivery_lines').select('id')
                          .or(`plan_stop_id.eq.${stop.id},and(store_id.eq.${stop.store_id},delivered_on.eq.${dateStr})`)
                        if (dls?.length) {
                          for (const dl of dls) {
                            await supabase.from('returns').delete().eq('delivery_line_id', dl.id)
                          }
                          await supabase.from('delivery_lines').delete().in('id', dls.map(d => d.id))
                        }
                        // Sweep returns entered during this visit even if linked to older deliveries
                        await supabase.from('returns').delete()
                          .eq('store_id', stop.store_id)
                          .eq('returned_on', dateStr)
                        setCompletedStopIds(s => { const n = new Set(s); n.delete(stop.id); return n })
                      }} className="text-[var(--text-muted2)] hover:text-red-400 text-xs transition-colors">
                        Undo
                      </button>
                    </div>
                  ) : (
                    (!stop.requirements || stop.requirements.length === 0 || stop.requirements.every(r => (r.approved_qty ?? r.proposed_qty) === 0)) ? (
                      <div className="flex items-center gap-2">
                        <MarkVisitedForm stop={stop} onDone={() => setCompletedStopIds(s => new Set([...s, stop.id]))} />
                        <button onClick={async () => {
                          await supabase.from('plan_stops').delete().eq('id', stop.id)
                          loadPlan(selectedDate)
                        }} className="text-red-400 text-xs px-2 py-1.5 rounded-lg bg-[var(--bg-input)]/40 hover:bg-red-400/20 transition-colors">
                          Remove
                        </button>
                      </div>
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
          }

          return (
            <>
              {activeStops.map((stop, listIdx) => {
                const idx = orderedStops.findIndex(s => s.id === stop.id)
                // A drop line appears BEFORE this card when:
                // - dragging downward: overIdx === idx and dragIdx < idx  → line above target
                // - dragging upward:  overIdx === idx and dragIdx > idx  → line above target (card slides down)
                const showLineBefore = dragIdx !== null && overIdx === idx && overIdx !== dragIdx
                return (
                  <React.Fragment key={stop.id}>
                    {showLineBefore && (
                      <div style={{height: 3, borderRadius: 2, background: 'var(--accent)', boxShadow: '0 0 8px 2px var(--accent)', margin: '0 8px'}} />
                    )}
                    {renderCard(stop, idx, true)}
                  </React.Fragment>
                )
              })}
              {/* Line at end when dragging to last position */}
              {dragIdx !== null && overIdx === activeStops.length - 1 && dragIdx < activeStops.length - 1 && (
                <div style={{height: 3, borderRadius: 2, background: 'var(--accent)', boxShadow: '0 0 8px 2px var(--accent)', margin: '0 8px'}} />
              )}

              {doneStops.length > 0 && (
                <div className="mt-1">
                  <button onClick={() => setShowDelivered(v => !v)}
                    className="w-full flex items-center justify-between bg-[var(--bg-card)]/60 rounded-xl px-4 py-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-input)]/60 transition-colors">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle size={13} className="text-[var(--accent)]" /> Delivered ({doneStops.length})
                    </span>
                    <ChevronDown size={14} className={showDelivered ? 'rotate-180 transition-transform' : 'transition-transform'} />
                  </button>
                  {showDelivered && (
                    <div className="flex flex-col gap-2 mt-2">
                      {doneStops.map(stop => {
                        const idx = orderedStops.findIndex(s => s.id === stop.id)
                        return renderCard(stop, idx, false)
                      })}
                    </div>
                  )}
                </div>
              )}

              {skippedStops.length > 0 && (
                <div className="mt-1">
                  <button onClick={() => setShowSkipped(v => !v)}
                    className="w-full flex items-center justify-between bg-[var(--bg-card)]/60 rounded-xl px-4 py-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-input)]/60 transition-colors">
                    <span className="flex items-center gap-1.5">Skipped ({skippedStops.length})</span>
                    <ChevronDown size={14} className={showSkipped ? 'rotate-180 transition-transform' : 'transition-transform'} />
                  </button>
                  {showSkipped && (
                    <div className="flex flex-col gap-2 mt-2">
                      {skippedStops.map(stop => {
                        const idx = orderedStops.findIndex(s => s.id === stop.id)
                        return renderCard(stop, idx, false)
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )
        })()}
      </div>

      {quickOpen && <QuickDeliverModal onClose={() => setQuickOpen(false)} onSaved={() => loadPlan?.()} />}
      {addStopOpen && planId && (
        <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
            <span className="text-[var(--text-primary)] font-semibold">Add stop / Prospects</span>
            <button onClick={() => setAddStopOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <AddStopPanel planId={planId} stops={stops} selectedDate={selectedDate}
              onClose={() => setAddStopOpen(false)}
              onAdded={() => { setAddStopOpen(false); loadPlan(selectedDate) }} />
          </div>
        </div>
      )}

      {activeCompleteStop && (
        <div className="absolute inset-0 bg-[var(--bg-root)]/70 backdrop-blur-2xl backdrop-saturate-150 flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0 bg-[var(--bg-card)]/40 backdrop-blur-xl">
            <h2 className="text-[var(--text-primary)] font-semibold"><a href={activeCompleteStop.stores?.place_id ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeCompleteStop.stores.name || "")}&query_place_id=${activeCompleteStop.stores.place_id}` : (activeCompleteStop.stores?.lat && activeCompleteStop.stores?.lng) ? `https://www.google.com/maps/search/?api=1&query=${activeCompleteStop.stores.lat},${activeCompleteStop.stores.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeCompleteStop.stores?.name || '')}`} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text-accent)] hover:underline">{activeCompleteStop.stores?.name}</a></h2>
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
                        const avail = Math.max(0, batchAvail(b))
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

      {prospectOpen && planId && (
        <ProspectVisitModal
          planId={planId}
          stops={stops}
          depot={depot}
          matrixSeconds={matrixSeconds}
          onClose={() => setProspectOpen(false)}
          onAdded={() => loadPlan(selectedDate)}
        />
      )}
    </div>
  )
}
