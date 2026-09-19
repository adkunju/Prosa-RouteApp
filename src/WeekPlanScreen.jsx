import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { useSettings } from './useSettings'
import { fuzzyMatch } from './fuzzy'
import { computeProposedQty, bearingFromDepot } from './forecastMath'
import { Calendar, Lock, Unlock, AlertTriangle, CheckCircle, Loader2, Package } from 'lucide-react'

const NUM_DAYS = 6
const DAILY_BUDGET_MIN = 360 // 6 hours

function dayLabel(iso, { short = false } = {}) {
  const d = new Date(iso + 'T00:00:00')
  const wd = d.toLocaleDateString('en-GB', { weekday: short ? 'short' : 'long' })
  if (short) return `${wd} ${d.getDate()}`
  return `${wd} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`
}

function dateForOffset(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  // Use local date parts to avoid UTC midnight drift (IST = UTC+5:30)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function daysUntil(dateStr) {
  const now = new Date(localToday() + 'T00:00:00')
  const target = new Date(dateStr + 'T00:00:00')
  return Math.round((target - now) / 86400000)
}

function formatDuration(mins) {
  const total = Math.round(mins)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} hr`
  return `${h} hr ${m} min`
}

export default function WeekPlanScreen() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [dueStores, setDueStores] = useState([]) // [{store_id, name, service_minutes, due_date, bearing, skuReqs:[{sku_id,name,qty}]}]
  const [assignment, setAssignment] = useState({}) // storeId -> dayIndex
  const { settings, loaded: settingsLoaded } = useSettings()
  // Calendar dates for the next N delivery days, skipping weekdays that are
  // switched off in settings.
  const planDates = useMemo(() => {
    const allowed = settings.delivery_weekdays || [1, 2, 3, 4, 5, 6]
    const out = []
    const d = new Date()
    for (let i = 0; i < 60 && out.length < allowed.length; i++) {
      const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const dow = d.getDay() === 0 ? 7 : d.getDay()
      if (allowed.includes(dow)) out.push(iso)
      d.setDate(d.getDate() + 1)
    }
    return out
  // Include today's date as a dep so the window shifts at midnight
  // and on hard reload, rather than freezing at first render.
  }, [settings.delivery_weekdays, localToday()])

  const NUM_DAYS = planDates.length
  const DAILY_BUDGET_MIN = settings.daily_budget_min
  const [locked, setLocked] = useState({}) // storeId -> bool
  const [pickupDue, setPickupDue] = useState([])
  const [unscheduled, setUnscheduled] = useState([])
  const [allStores, setAllStores] = useState([])
  const [showPickupDetail, setShowPickupDetail] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [stalePlans, setStalePlans] = useState([])
  const [pendingProduction, setPendingProduction] = useState(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [cacheRestored, setCacheRestored] = useState(false)
  const [showProductionConfirm, setShowProductionConfirm] = useState(false)
  const [showAddStore, setShowAddStore] = useState(false)
  const [addStoreQuery, setAddStoreQuery] = useState('')
  const [addStoreQtys, setAddStoreQtys] = useState({}) // sku_id -> qty
  const [addStoreDay, setAddStoreDay] = useState(0)
  const [prodQtys, setProdQtys] = useState({})
  const [qtyOverrides, setQtyOverrides] = useState({}) // `storeId-skuId` -> qty
  const [matrixMap, setMatrixMap] = useState({})
  const [availableStock, setAvailableStock] = useState({}) // sku_id -> available pcs
  const [spareStock, setSpareStock] = useState({}) // sku_id -> spare pcs
  const [matrixMeters, setMatrixMeters] = useState({})
  const [depotId, setDepotId] = useState(null)

  const loadRef = useRef(null)
  async function load() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()

    const todayStr = localToday()
    const localDateStr = todayStr
    const { data: existingPlans } = await supabase.from('plans')
      .select('plan_date, plan_stops(store_id)')
      .eq('user_id', user.id)
      .gte('plan_date', planDates[0] || todayStr)
      .lt('plan_date', todayStr)
    setStalePlans(existingPlans || [])

    const [{ data: forecast }, { data: stores }, { data: matrix }, { data: batches }, { data: delivered }] = await Promise.all([
      supabase.from('store_sku_forecast').select('*').neq('pipeline_status', 'dropped'),
      supabase.from('stores').select('id, name, lat, lng, service_minutes, is_depot, is_pickup').eq('is_active', true),
      supabase.from('travel_matrix').select('from_store_id, to_store_id, seconds, meters'),
      supabase.from('production_batches').select('id, sku_id, qty, produced_on, expires_on, is_spare').gt('expires_on', localDateStr).order('produced_on'),
      supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
    ])

    // Build available stock map — split regular vs spare
    const consumedByBatch = {}
    ;(delivered || []).forEach(d => { consumedByBatch[d.batch_id] = (consumedByBatch[d.batch_id] || 0) + d.qty_delivered })
    const stockBySku = {}
    const spareBySku = {}
    const batchList = (batches || []).map(b => ({
      ...b,
      available: Math.max(0, b.qty - (consumedByBatch[b.id] || 0))
    })).filter(b => b.available > 0)
    batchList.forEach(b => {
      if (b.is_spare) spareBySku[b.sku_id] = (spareBySku[b.sku_id] || 0) + b.available
      else stockBySku[b.sku_id] = (stockBySku[b.sku_id] || 0) + b.available
    })
    setAvailableStock(stockBySku)
    setSpareStock(spareBySku)
    // Build per-day stock: how much of each SKU is available on each plan day
    const stockBySkuByDay = {} // sku_id -> array indexed by day offset
    for (let d = 0; d < NUM_DAYS; d++) {
      const dayDate = planDates[d] || dateForOffset(d)
      batchList.forEach(b => {
        if (b.produced_on <= dayDate) {
          if (!stockBySkuByDay[b.sku_id]) stockBySkuByDay[b.sku_id] = Array(NUM_DAYS).fill(0)
          stockBySkuByDay[b.sku_id][d] = (stockBySkuByDay[b.sku_id][d] || 0) + b.available
        }
      })
    }

    setAllStores((stores || []).filter(s => !s.is_depot && !s.is_pickup))
    const depot = stores.find(s => s.is_depot)
    const matrixMap = {}
    matrix.forEach(m => { matrixMap[`${m.from_store_id}_${m.to_store_id}`] = m.seconds })
    const metersMap = {}
    matrix.forEach(m => { metersMap[`${m.from_store_id}_${m.to_store_id}`] = m.meters })

    // Filter to stores due within window, group by store
    const dueWindow = (forecast || []).filter(r => daysUntil(r.next_visit_due) <= NUM_DAYS)
    const byStore = {}
    dueWindow.forEach(r => {
      if (!byStore[r.store_id]) {
        const store = stores.find(s => s.id === r.store_id)
        byStore[r.store_id] = {
          store_id: r.store_id,
          name: r.store_name,
          service_minutes: store?.service_minutes || 15,
          is_pickup: !!store?.is_pickup,
          due_date: r.next_visit_due,
          bearing: store ? bearingFromDepot(depot.lat, depot.lng, store.lat, store.lng) : 0,
          skuReqs: [],
        }
      }
      const { proposed } = computeProposedQty(r)
      byStore[r.store_id].skuReqs.push({ sku_id: r.sku_id, name: r.sku_name, qty: proposed })
      // earliest due date wins
      if (new Date(r.next_visit_due) < new Date(byStore[r.store_id].due_date)) {
        byStore[r.store_id].due_date = r.next_visit_due
      }
    })

    // Pickup stores still get forecast and allocated — they just never occupy a
    // route stop, so they are kept out of day assignment entirely.
    const allDue = Object.values(byStore)
    const stores_due = allDue.filter(s => !s.is_pickup)
    const pickupStores = allDue.filter(s => s.is_pickup)

    // Ration available stock across ALL due stores using total stock across all days
    // Use cumulative stock (today + future batches) for allocation planning
    const runningStock = { ...stockBySku }
    stores_due.forEach(s => {
      s.skuReqs = s.skuReqs.map(r => {
        const avail = runningStock[r.sku_id] ?? 0
        const qty = Math.min(r.qty, avail)
        runningStock[r.sku_id] = Math.max(0, avail - qty)
        return { ...r, qty, requested: r.qty }
      })
    })

    // Ration pickup stores from remaining stock after delivery stores
    pickupStores.forEach(s => {
      s.skuReqs = s.skuReqs.map(r => {
        const avail = runningStock[r.sku_id] ?? 0
        const qty = Math.min(r.qty, avail)
        runningStock[r.sku_id] = Math.max(0, avail - qty)
        return { ...r, qty, requested: r.qty }
      })
    })
    setPickupDue(pickupStores)

    // Split: zero-stock stores go to skipped popup, deliverable get routed
    const zeroStockSet = new Set(stores_due.filter(s => s.skuReqs.every(r => r.qty === 0)).map(s => s.store_id))
    const stores_to_assign = stores_due.filter(s => !zeroStockSet.has(s.store_id))
    const zeroStockStores = stores_due.filter(s => zeroStockSet.has(s.store_id))

    // Greedy day assignment: sort by due date, then bearing (cluster direction)
    stores_to_assign.sort((a, b) => {
      const d = new Date(a.due_date) - new Date(b.due_date)
      if (d !== 0) return d
      return a.bearing - b.bearing
    })

    const dayLists = Array.from({ length: NUM_DAYS }, () => [])
    const dayMins = Array(NUM_DAYS).fill(0)
    const assign = {}
    const overflow = []

    function legSeconds(fromId, toId) {
      return matrixMap[`${fromId}_${toId}`] ?? matrixMap[`${toId}_${fromId}`] ?? 600 // fallback 10 min
    }

    stores_to_assign.forEach(s => {
      const rawDue = daysUntil(s.due_date)
      const overdue = rawDue < 0
      const dueDay = overdue ? 0 : Math.max(0, Math.min(NUM_DAYS - 1, rawDue))
      let placed = false
      for (let day = 0; day <= dueDay; day++) {
        // Skip days where required SKUs aren't yet available from any batch
        const stockReadyOnDay = s.skuReqs.every(r => {
          if (r.qty === 0) return true
          return (stockBySkuByDay[r.sku_id]?.[day] ?? 0) > 0
        })
        if (!stockReadyOnDay) continue
        const list = dayLists[day]
        const last = list.length ? list[list.length - 1] : depot.id
        const prevReturn = list.length ? legSeconds(last, depot.id) : 0
        const addOut = legSeconds(last, s.store_id)
        const addBack = legSeconds(s.store_id, depot.id)
        const incrementalMin = (addOut + addBack - prevReturn) / 60 + s.service_minutes
        if (dayMins[day] + incrementalMin <= DAILY_BUDGET_MIN) {
          dayLists[day].push(s.store_id)
          dayMins[day] += incrementalMin
          assign[s.store_id] = day
          placed = true
          break
        }
      }
      // Not in the due window — try any other day, still inside the budget.
      if (!placed) {
        for (let day = 0; day < NUM_DAYS && !placed; day++) {
          const stockReadyOnDay = s.skuReqs.every(r => r.qty === 0 || (stockBySkuByDay[r.sku_id]?.[day] ?? 0) > 0)
          if (!stockReadyOnDay) continue
          const list = dayLists[day]
          const last = list.length ? list[list.length - 1] : depot.id
          const prevReturn = list.length ? legSeconds(last, depot.id) : 0
          const inc = (legSeconds(last, s.store_id) + legSeconds(s.store_id, depot.id) - prevReturn) / 60 + s.service_minutes
          if (dayMins[day] + inc <= DAILY_BUDGET_MIN) {
            dayLists[day].push(s.store_id)
            dayMins[day] += inc
            assign[s.store_id] = day
            placed = true
          }
        }
      }
    // Fits nowhere inside the working day: leave it unscheduled
      if (!placed) overflow.push(s)
    })



    setMatrixMap(matrixMap)
    setMatrixMeters(metersMap)
    setDepotId(depot.id)
    setUnscheduled([
      ...zeroStockStores.map(s => ({ ...s, skipReason: 'No stock available today' })),
      ...overflow.map(s => ({ ...s, skipReason: 'No gap in time budget' })),
    ])
    // Ignore saved assignments from before today — they're stale and would
    // override the fresh computation with yesterday's plan.
    const staleIds = new Set()
    ;(existingPlans || []).filter(p => p.plan_date < todayStr).forEach(p => {
      ;(p.plan_stops || []).forEach(ps => staleIds.add(ps.store_id))
    })
    stores_to_assign.forEach(s => { if (staleIds.has(s.store_id)) delete assign[s.store_id] })

    setDueStores(stores_due.filter(s => s.skuReqs.some(r => r.qty > 0)))
    setAssignment(assign)
    setLoading(false)
  }

  loadRef.current = load

  useEffect(() => {
    const raw = sessionStorage.getItem('prosa_production_prefill')
    if (raw) { try { setPendingProduction(JSON.parse(raw)) } catch { /* ignore */ } }
    const clear = () => setPendingProduction(null)
    const onProdConfirmed = () => {
      setPendingProduction(null)
      sessionStorage.removeItem('prosa_schedule_cache')
      loadRef.current?.()
    }
    window.addEventListener('prosa:production_confirmed', onProdConfirmed)
    return () => window.removeEventListener('prosa:production_confirmed', onProdConfirmed)
  }, [])

  // Clear cache if budget setting changed
  useEffect(() => {
    const cached = sessionStorage.getItem('prosa_schedule_cache')
    if (cached) {
      try {
        const { budget } = JSON.parse(cached)
        if (budget !== undefined && budget !== DAILY_BUDGET_MIN) {
          sessionStorage.removeItem('prosa_schedule_cache')
        }
      } catch { /* ignore */ }
    }
  }, [DAILY_BUDGET_MIN])

  useEffect(() => {
    if (!settingsLoaded) return
    // Restore cached state if the plan dates haven't changed
    const cached = sessionStorage.getItem('prosa_schedule_cache')
    if (cached) {
      try {
        const { dates, assignment: savedAssign, dueStores: savedStores, pickupDue: savedPickup, availableStock: savedStock, spareStock: savedSpare, locked: savedLocked, unscheduled: savedUnscheduled, qtyOverrides: savedQtyOverrides } = JSON.parse(cached)
        if (dates === planDates.join(',')) {
          setDueStores((savedStores || []).filter(s => s.skuReqs.some(r => r.qty > 0)))
          setUnscheduled(savedUnscheduled || [])
          setQtyOverrides(savedQtyOverrides || {})
          setSpareStock(savedSpare || {})
          setAssignment(savedAssign || {})
          setPickupDue(savedPickup || [])
          setAvailableStock(savedStock || {})
          setLocked(savedLocked || {})
          setAvailableStock(savedStock || {})
          // Still need depot + matrix even on cache restore
          ;(async () => {
          const [{ data: storesData }, { data: matrixData }] = await Promise.all([
            supabase.from('stores').select('id, name, lat, lng, service_minutes, is_depot, is_pickup').eq('is_active', true),
            supabase.from('travel_matrix').select('from_store_id, to_store_id, seconds, meters'),
          ])
          const depot = (storesData || []).find(s => s.is_depot)
          setAllStores((storesData || []).filter(s => !s.is_depot && !s.is_pickup))
          if (depot) setDepotId(depot.id)
          const mm = {}, ms = {}
          ;(matrixData || []).forEach(r => {
            mm[`${r.from_store_id}_${r.to_store_id}`] = r.seconds
            ms[`${r.from_store_id}_${r.to_store_id}`] = r.meters
          })
          setMatrixMap(mm)
          setMatrixMeters(ms)
          setLoading(false)
          setCacheRestored(true)
          })()
          return
        }
      } catch { /* ignore */ }
    }
    load()
  }, [settingsLoaded, NUM_DAYS, DAILY_BUDGET_MIN, planDates.join(',')])

  // Persist schedule state so tab switches don't reset it
  useEffect(() => {
    if (loading || dueStores.length === 0 || Object.keys(assignment).length === 0 || cacheRestored) { setCacheRestored(false); return }
    sessionStorage.setItem('prosa_schedule_cache', JSON.stringify({
      dates: planDates.join(','),
      budget: DAILY_BUDGET_MIN,
      assignment,
      dueStores,
      pickupDue,
      availableStock,
      spareStock,
      locked,
      unscheduled,
      qtyOverrides,
    }))
  }, [assignment, dueStores, locked, pickupDue, availableStock, spareStock, unscheduled, qtyOverrides])

  function moveStore(storeId, newDay) {
    setAssignment(a => ({ ...a, [storeId]: newDay }))
    setHasUnsavedChanges(true)
    setSaved(false)
  }

  function skipStore(store) {
    setDueStores(ds => ds.filter(s => s.store_id !== store.store_id))
    setUnscheduled(u => [...u, { ...store, skipReason: 'Manually skipped' }])
    setAssignment(a => { const n = { ...a }; delete n[store.store_id]; return n })
    setHasUnsavedChanges(true)
    setSaved(false)
  }

  function toggleLock(storeId) {
    setLocked(l => ({ ...l, [storeId]: !l[storeId] }))
  }

  const byDay = useMemo(() => {
    const grouped = Array.from({ length: NUM_DAYS }, () => [])
    dueStores.forEach(s => {
      const day = assignment[s.store_id] ?? 0
      grouped[day].push(s)
    })
    return grouped
  }, [dueStores, assignment])

  const leg = (a, b) => (a === b ? 0 : (matrixMap[`${a}_${b}`] ?? matrixMap[`${b}_${a}`] ?? 600))

  // Order each day: nearest-neighbour seed then 2-opt (matches Delivery screen)
  const dayRoutes = useMemo(() => {
    if (!depotId) return byDay.map(() => [])
    return byDay.map(stops => {
      if (!stops.length) return []
      // Nearest-neighbour seed
      const pool = [...stops]
      const out = []
      let cur = depotId
      while (pool.length) {
        let bi = 0
        for (let i = 1; i < pool.length; i++) {
          if (leg(cur, pool[i].store_id) < leg(cur, pool[bi].store_id)) bi = i
        }
        out.push(pool[bi]); cur = pool[bi].store_id; pool.splice(bi, 1)
      }
      // 2-opt improvement
      const routeCost = (route) => {
        let t = leg(depotId, route[0].store_id)
        for (let i = 0; i < route.length - 1; i++) t += leg(route[i].store_id, route[i+1].store_id)
        t += leg(route[route.length - 1].store_id, depotId)
        return t
      }
      let best = [...out]
      let improved = true
      while (improved) {
        improved = false
        for (let i = 0; i < best.length - 1; i++) {
          for (let j = i + 1; j < best.length; j++) {
            const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)]
            if (routeCost(candidate) < routeCost(best) - 0.0001) {
              best = candidate; improved = true
            }
          }
        }
      }
      return best
    })
  }, [byDay, matrixMap, depotId])

  // Recomputed on every change: route each day depot -> stops -> depot using
  // real matrix legs, plus service time at each stop.
  const dayKm = useMemo(() => {
    const m = (a, b) => (a === b ? 0 : (matrixMeters[`${a}_${b}`] ?? matrixMeters[`${b}_${a}`] ?? 0))
    return dayRoutes.map(stops => {
      if (!stops.length || !depotId) return 0
      let meters = 0
      let prev = depotId
      stops.forEach(s => { meters += m(prev, s.store_id); prev = s.store_id })
      meters += m(prev, depotId)
      return Math.round(meters / 100) / 10
    })
  }, [dayRoutes, matrixMeters, depotId])

  const dayMinutes = useMemo(() => {
    return dayRoutes.map(stops => {
      if (!stops.length || !depotId) return 0
      let seconds = 0
      let prev = depotId
      stops.forEach(s => { seconds += leg(prev, s.store_id); prev = s.store_id })
      seconds += leg(prev, depotId)
      const service = stops.reduce((a, s) => a + (s.service_minutes || 15), 0)
      return Math.round(seconds / 60 + service)
    })
  }, [dayRoutes, matrixMap, depotId])

  // Cost of adding a store to a day: travel from the nearest stop already on
  // that day, plus the time spent in the store. Simple and always positive.
  const moveImpact = useCallback((store) => {
    if (!depotId) return []
    const from = assignment[store.store_id] ?? 0
    const svc = store.service_minutes || 15
    return byDay.map((stops, d) => {
      if (d === from) return { day: d, cost: 0, current: true }
      const others = stops.filter(x => x.store_id !== store.store_id)
      let nearest = leg(depotId, store.store_id)
      others.forEach(o => {
        const t = leg(o.store_id, store.store_id)
        if (t < nearest) nearest = t
      })
      const late = (planDates[d] || dateForOffset(d)) > store.due_date
      return { day: d, cost: Math.round(nearest / 60 + svc), current: false, late }
    })
  }, [byDay, matrixMap, depotId, assignment])

  // Batched: a handful of round trips regardless of store count. The previous
  // version issued one select plus one write per stop and per SKU, which grew
  // linearly and took ~15s.
  async function resetPlan() {
    setResetting(true)
    setAssignment({})
    setDueStores([])
    setQtyOverrides({})
    sessionStorage.removeItem('prosa_schedule_cache')
    const { data: { user } } = await supabase.auth.getUser()
    const today = new Date().toISOString().slice(0, 10)
    // Find all future plans
    const { data: futurePlans } = await supabase.from('plans')
      .select('id').eq('user_id', user.id).gte('plan_date', today)
    if (futurePlans?.length) {
      const ids = futurePlans.map(p => p.id)
      // Only delete stops that have no delivery lines (don't touch history)
      const { data: stops } = await supabase.from('plan_stops')
        .select('id, delivery_lines(id)').in('plan_id', ids)
      const deletable = (stops || []).filter(s => !s.delivery_lines?.length).map(s => s.id)
      if (deletable.length) {
        await supabase.from('requirements').delete().in('plan_stop_id', deletable)
        await supabase.from('plan_stops').delete().in('id', deletable)
      }
    }
    setResetting(false)
    setHasUnsavedChanges(false)
    setSaved(false)
    load() // recompute from scratch
  }

  async function saveWeekPlan(_dueStores, _assignment, _qtyOverrides) {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()

    const dates = []
    for (let d = 0; d < NUM_DAYS; d++) dates.push(planDates[d] || dateForOffset(d))

    // 1. plans for every day at once
    await supabase.from('plans')
      .upsert(dates.map(plan_date => ({ user_id: user.id, plan_date, status: 'draft' })),
              { onConflict: 'user_id,plan_date', ignoreDuplicates: true })
    const { data: plans } = await supabase.from('plans')
      .select('id, plan_date').eq('user_id', user.id).in('plan_date', dates)
    const planIdByDate = {}
    ;(plans || []).forEach(p => { planIdByDate[p.plan_date] = p.id })
    const planIds = Object.values(planIdByDate)

    // 2. what already exists, and which stops are protected by real deliveries
    const { data: existingStops } = await supabase.from('plan_stops')
      .select('id, plan_id, store_id, delivery_lines(id)').in('plan_id', planIds)

    const effectiveDueStores = _dueStores || dueStores
    const effectiveAssignment = _assignment || assignment
    const effectiveOverrides = _qtyOverrides || qtyOverrides
    const effectiveByDay = {}
    effectiveDueStores.forEach(s => {
      const day = effectiveAssignment[s.store_id] ?? 0
      if (!effectiveByDay[day]) effectiveByDay[day] = []
      effectiveByDay[day].push(s)
    })

    const wanted = new Set()
    dates.forEach((date, day) => {
      (effectiveByDay[day] || []).forEach(s => wanted.add(`${planIdByDate[date]}_${s.store_id}`))
    })

    const toDelete = (existingStops || [])
      .filter(ps => !wanted.has(`${ps.plan_id}_${ps.store_id}`))
      .filter(ps => (ps.delivery_lines || []).length === 0)
      .map(ps => ps.id)

    if (toDelete.length) {
      await supabase.from('requirements').delete().in('plan_stop_id', toDelete)
      await supabase.from('plan_stops').delete().in('id', toDelete)
    }

    // 3. all stops in one write
    const stopRows = []
    dates.forEach((date, day) => {
      const planId = planIdByDate[date]
      if (!planId) return
      ;(effectiveByDay[day] || []).forEach((s, idx) => {
        stopRows.push({ plan_id: planId, store_id: s.store_id, stop_order: idx + 1, locked: !!locked[s.store_id] })
      })
    })
    if (stopRows.length) {
      await supabase.from('plan_stops').upsert(stopRows, { onConflict: 'plan_id,store_id' })
    }

    // 4. resolve ids, then all requirements in one write
    const { data: savedStops } = await supabase.from('plan_stops')
      .select('id, plan_id, store_id').in('plan_id', planIds)
    const stopIdByKey = {}
    ;(savedStops || []).forEach(ps => { stopIdByKey[`${ps.plan_id}_${ps.store_id}`] = ps.id })

    const reqRows = []
    dates.forEach((date, day) => {
      const planId = planIdByDate[date]
      ;(effectiveByDay[day] || []).forEach(s => {
        const stopId = stopIdByKey[`${planId}_${s.store_id}`]
        if (!stopId) return
        s.skuReqs.forEach(r => {
          const key = `${s.store_id}-${r.sku_id}`
          const qty = effectiveOverrides[key] !== undefined ? Number(effectiveOverrides[key]) : r.qty
          reqRows.push({ plan_stop_id: stopId, sku_id: r.sku_id, proposed_qty: r.qty, approved_qty: qty, source: 'auto' })
        })
      })
    })
    if (reqRows.length) {
      await supabase.from('requirements').upsert(reqRows, { onConflict: 'plan_stop_id,sku_id' })
    }

    setSaving(false)
    setSaved(true)
    setHasUnsavedChanges(false)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
        <span className="text-[var(--text-muted)] text-sm flex items-center gap-1.5">
          <Calendar size={14} className="text-[var(--text-accent)]" /> {NUM_DAYS}-day plan
        </span>
        <span className="text-[var(--text-muted2)] text-xs">Max {DAILY_BUDGET_MIN / 60}h/day per route</span>
        {(() => {
          const today = new Date().toISOString().slice(0, 10)
          const weekStart = planDates[0] || today
          const stale = stalePlans.some(p => p.plan_date >= weekStart && p.plan_date < today && p.plan_stops?.length > 0)
          return (
            <>
            <button onClick={resetPlan} disabled={resetting}
              className={`text-xs disabled:opacity-50 transition-colors font-medium ${stale ? 'text-red-400 hover:text-red-300' : 'text-[var(--text-muted2)] hover:text-[var(--text-primary)]'}`}>
              {resetting ? 'Resetting...' : stale ? '⚠ Reset & recompute' : 'Reset & recompute'}
            </button>
            <button onClick={() => { setAddStoreQuery(''); setAddStoreQtys({}); setAddStoreDay(0); setShowAddStore(true) }}
              className="text-[var(--accent)] text-xs font-medium hover:opacity-80 transition-colors ml-2">
              + Add store
            </button>
          </>
        )
        })()}
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-5">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Computing assignments...</div>}

        {pendingProduction && (
          <div className="bg-[var(--text-gold)]/10 border border-[var(--text-gold)]/40 rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[var(--text-primary)] text-sm font-semibold mb-1">⚠ Production not confirmed</div>
                <div className="text-[var(--text-muted2)] text-xs">
                  {pendingProduction.totals.map(t => `${t.sku_name}: ${t.qty} pcs`).join(' · ')} · for {pendingProduction.date}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setPendingProduction(null)}
                  className="text-[var(--text-muted2)] text-xs px-2 py-2 hover:text-[var(--text-primary)]">
                  Dismiss
                </button>
                <button
                  onClick={() => setShowProductionConfirm(true)}
                  className="bg-[var(--text-gold)] text-white text-xs font-semibold rounded-xl px-3 py-2 hover:opacity-90">
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && unscheduled.length > 0 && (
          <div className="bg-red-900/20 border border-red-700/30 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-red-300 text-sm font-medium">
                {unscheduled.length} store{unscheduled.length > 1 ? 's' : ''} skipped
              </span>
              <button onClick={() => setShowSkipped(true)}
                className="text-red-300 hover:text-white text-xs underline">
                View
              </button>
            </div>
          </div>
        )}

        {!loading && (() => {
          // Overallocation check per SKU
          const overallocatedSkus = Object.entries(availableStock).filter(([skuId, total]) => {
            const totalWithSpare = total + (spareStock[skuId] || 0)
            const allocated = dueStores.reduce((n, s) => {
              const key = `${s.store_id}-${skuId}`
              return n + (qtyOverrides[key] !== undefined ? Number(qtyOverrides[key]) : (s.skuReqs.find(r => r.sku_id === skuId)?.qty || 0))
            }, 0)
            return allocated > totalWithSpare
          })
          if (!overallocatedSkus.length) return null
          return (
            <div className="mx-4 mb-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <div className="text-red-400 text-xs font-semibold mb-1">⚠ Stock overallocated</div>
              {overallocatedSkus.map(([skuId, total]) => {
                const totalWithSpare = total + (spareStock[skuId] || 0)
                const allocated = dueStores.reduce((n, s) => {
                  const key = `${s.store_id}-${skuId}`
                  return n + (qtyOverrides[key] !== undefined ? Number(qtyOverrides[key]) : (s.skuReqs.find(r => r.sku_id === skuId)?.qty || 0))
                }, 0)
                const skuName = dueStores.flatMap(s => s.skuReqs).find(r => r.sku_id === skuId)?.name || skuId
                return <div key={skuId} className="text-red-300 text-xs">{skuName}: {allocated} allocated · {totalWithSpare} available · reduce by {allocated - totalWithSpare}</div>
              })}
            </div>
          )
        })()}

        {!loading && Object.keys(availableStock).length > 0 && (() => {
          // Build sku name map from dueStores
          const skuNames = {}
          dueStores.forEach(s => s.skuReqs.forEach(r => { skuNames[r.sku_id] = r.name }))
          pickupDue.forEach(s => s.skuReqs.forEach(r => { skuNames[r.sku_id] = r.name }))
          return (
            <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
              <div className="text-[var(--text-muted)] text-xs mb-2">Stock in hand · allocated to schedule</div>
              {Object.entries(availableStock).map(([skuId, total]) => {
                const spare = spareStock[skuId] || 0
                const totalAllocated =
                  dueStores.reduce((n, s) => {
                    const key = `${s.store_id}-${skuId}`
                    return n + (qtyOverrides[key] !== undefined ? Number(qtyOverrides[key]) : (s.skuReqs.find(r => r.sku_id === skuId)?.qty || 0))
                  }, 0)
                  + pickupDue.reduce((n, s) => n + (s.skuReqs.find(r => r.sku_id === skuId)?.qty || 0), 0)
                const regularUsed = Math.min(totalAllocated, total)
                const spareUsed = Math.max(0, totalAllocated - total)
                const regularLeft = total - regularUsed
                const spareLeft = spare - spareUsed
                return (
                  <div key={skuId} className="flex justify-between text-sm py-1 border-t border-[var(--bg-input)]/30 first:border-0">
                    <span className="text-[var(--text-secondary)]">{skuNames[skuId] || 'Unknown'}</span>
                    <div className="text-[var(--text-muted2)] text-xs text-right">
                      <div>
                        {regularUsed}/{total} allocated · <span className={regularLeft === 0 ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>{regularLeft} left</span>
                      </div>
                      {spare > 0 && (
                        <div className={spareUsed > spare ? 'text-red-400' : spareUsed > 0 ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted2)]'}>
                          {spareUsed}/{spare} spare · {spareLeft} left
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {!loading && pickupDue.length > 0 && (
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--text-gold)]/30 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-primary)] text-sm font-medium flex items-center gap-2">
                <Package size={14} className="text-[var(--text-gold)]" /> Collecting from depot
              </span>
              <button onClick={() => setShowPickupDetail(true)}
                className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-xs transition-colors">
                {pickupDue.length} stores ›
              </button>
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--bg-input)]/40">
              {Object.entries(pickupDue.reduce((acc, s) => {
                s.skuReqs.forEach(r => { acc[r.name] = (acc[r.name] || 0) + r.qty })
                return acc
              }, {})).map(([name, qty]) => (
                <div key={name} className="flex justify-between text-xs py-0.5">
                  <span className="text-[var(--text-muted2)]">{name}</span>
                  <span className="text-[var(--text-secondary)] font-medium">{qty} pcs</span>
                </div>
              ))}
            </div>

          </div>
        )}
        {!loading && Array.from({ length: NUM_DAYS }).map((_, day) => {
          const stops = byDay[day]
          const mins = dayMinutes[day]
          const overloaded = mins > DAILY_BUDGET_MIN
          return (
            <div key={day}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[var(--text-primary)] text-sm font-semibold">
                  {dayLabel(planDates[day] || dateForOffset(day))}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${overloaded ? 'bg-red-900/60 text-red-300' : 'bg-[var(--bg-input)] text-[var(--text-secondary)]'}`}>
                  {formatDuration(mins)} · {dayKm[day] || 0} km · {stops.length} stops
                  {overloaded && <AlertTriangle size={11} className="inline ml-1" />}
                </span>
              </div>
              {stops.length === 0 && <div className="text-[var(--text-faint)] text-xs pl-1">No stops</div>}
              <div className="flex flex-col gap-2">
                {stops.map(s => (
                  <div key={s.store_id} className="bg-[var(--bg-card)] rounded-xl p-3">
                    {/* Row 1: lock + name + day picker */}
                    <div className="flex items-center gap-2 mb-1">
                      <button onClick={() => toggleLock(s.store_id)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0">
                        {locked[s.store_id] ? <Lock size={14} className="text-[var(--text-gold)]" /> : <Unlock size={14} />}
                      </button>
                      <span className="text-[var(--text-primary)] text-sm font-medium flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis">{s.name}</span>
                      <select
                        value={assignment[s.store_id] ?? 0}
                        onChange={e => moveStore(s.store_id, Number(e.target.value))}
                        disabled={locked[s.store_id]}
                        className="bg-[var(--bg-input)] text-[var(--text-primary)] text-xs rounded-lg px-2 py-1 outline-none disabled:opacity-40 shrink-0"
                      >
                        {moveImpact(s).map(({ day: d, cost, current, late }) => (
                          <option key={d} value={d}>
                            {dayLabel(planDates[d] || dateForOffset(d), { short: true })}{current ? '' : ` +${cost}m`}{late ? ' ⚠' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* Row 2: sku info */}
                    <div className="text-[var(--text-muted2)] text-xs ml-5 mb-1">
                      {s.skuReqs.map(r => {
                        const key = `${s.store_id}-${r.sku_id}`
                        const qty = qtyOverrides[key] !== undefined ? qtyOverrides[key] : r.qty
                        const short = r.requested && qty < r.requested
                        return `${r.name}: ${qty}${short ? ` ↓${r.requested}` : ''}`
                      }).join(' · ')}
                      {s.skuReqs.some(r => {
                        const key = `${s.store_id}-${r.sku_id}`
                        const qty = qtyOverrides[key] !== undefined ? qtyOverrides[key] : r.qty
                        return r.requested && qty < r.requested
                      }) && <span className="text-[var(--text-gold)]"> · short</span>}
                      {' · due '}{s.due_date}
                    </div>
                    {/* Row 3: qty steppers */}
                    {s.skuReqs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 ml-5">
                        {s.skuReqs.map(r => {
                          const key = `${s.store_id}-${r.sku_id}`
                          const qty = qtyOverrides[key] !== undefined ? qtyOverrides[key] : r.qty
                          return (
                            <div key={r.sku_id} className="flex items-center gap-1 bg-[var(--bg-input)]/40 rounded-lg px-1.5 py-0.5">
                              <span className="text-[var(--text-muted2)] text-[10px]">{r.name.split('/')[0].trim()}</span>
                              <button onClick={() => { setQtyOverrides(o => ({ ...o, [key]: Math.max(0, qty - 1) })); setHasUnsavedChanges(true); setSaved(false) }}
                                className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] w-4 h-4 flex items-center justify-center">−</button>
                              <span className={`text-xs font-medium w-5 text-center ${qty === 0 ? 'text-[var(--text-muted2)]' : 'text-[var(--text-primary)]'}`}>{qty}</span>
                              <button onClick={() => { setQtyOverrides(o => ({ ...o, [key]: qty + 1 })); setHasUnsavedChanges(true); setSaved(false) }}
                                className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] w-4 h-4 flex items-center justify-center">+</button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {/* Skip button */}
                    <div className="ml-5 mt-1.5">
                      <button onClick={() => skipStore(s)}
                        className="text-[var(--text-muted2)] hover:text-red-400 text-xs transition-colors">
                        Skip this store
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {!loading && dueStores.length > 0 && (
        <div className="p-4 border-t border-[var(--bg-input)] shrink-0">

          <button
            onClick={() => { if (hasUnsavedChanges) saveWeekPlan() }}
            disabled={saving}
            className={`w-full text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-all ${
              saved
                ? 'bg-green-600 hover:bg-green-700'
                : hasUnsavedChanges
                  ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
                  : 'bg-[var(--accent)]/30 cursor-default'
            }`}
          >
            {saved ? <><CheckCircle size={18} /> Saved!</> : saving ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : <>{hasUnsavedChanges && <AlertTriangle size={14} className="text-[var(--text-gold)]" />} Save Week Plan</>}
          </button>
        </div>
      )}
    {showProductionConfirm && pendingProduction && createPortal(
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col items-center justify-center p-6"
          onClick={() => setShowProductionConfirm(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="text-[var(--text-primary)] text-base font-semibold mb-1">Confirm production</div>
            <div className="text-[var(--text-muted2)] text-xs mb-4">Enter the actual quantities produced for {pendingProduction.date}.</div>
            <div className="flex flex-col gap-3 mb-5">
              {pendingProduction.totals.map(t => (
                <div key={t.sku_name} className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-secondary)] text-sm">{t.sku_name}</span>
                  <div className="flex items-center gap-2 bg-[var(--bg-input)]/40 rounded-xl px-3 py-1.5">
                    <button onClick={() => setProdQtys(q => ({ ...q, [t.sku_name]: Math.max(0, (q[t.sku_name] ?? t.qty) - 1) }))}
                      className="text-[var(--text-muted2)] hover:text-white w-5 h-5 flex items-center justify-center">−</button>
                    <span className="text-[var(--text-primary)] font-semibold w-8 text-center text-sm">
                      {prodQtys[t.sku_name] ?? t.qty}
                    </span>
                    <button onClick={() => setProdQtys(q => ({ ...q, [t.sku_name]: (q[t.sku_name] ?? t.qty) + 1 }))}
                      className="text-[var(--text-muted2)] hover:text-white w-5 h-5 flex items-center justify-center">+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => {
                  sessionStorage.removeItem('prosa_production_prefill')
                  setPendingProduction(null)
                  setShowProductionConfirm(false)
                }}
                className="flex-1 py-2.5 rounded-xl border border-[var(--bg-input)] text-[var(--text-secondary)] text-sm">
                Dismiss
              </button>
              <button onClick={async () => {
                  const { data: { user } } = await supabase.auth.getUser()
                  const today = pendingProduction.date
                  const rows = pendingProduction.totals.map(t => ({
                    produced_on: today,
                    expires_on: (() => { const d = new Date(today); d.setDate(d.getDate() + (t.shelf_days || 7)); return d.toISOString().slice(0,10) })(),
                    sku_id: t.sku_id,
                    qty: prodQtys[t.sku_name] ?? t.qty,
                    user_id: user.id,
                  }))
                  await supabase.from('production_batches').insert(rows)
                  sessionStorage.removeItem('prosa_production_prefill')
                  setPendingProduction(null)
                  setShowProductionConfirm(false)
                  window.dispatchEvent(new CustomEvent('prosa:production_confirmed'))
                }}
                className="flex-1 py-2.5 rounded-xl bg-[var(--text-gold)] text-white text-sm font-semibold">
                Save batch
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

    {showSkipped && createPortal(
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col"
          onClick={() => setShowSkipped(false)}>
          <div onClick={e => e.stopPropagation()}
            className="m-4 mt-16 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-4 max-h-[75vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[var(--text-primary)] text-sm font-semibold">Stores not scheduled</span>
              <button onClick={() => setShowSkipped(false)} className="text-[var(--text-muted)]">✕</button>
            </div>
            <p className="text-[var(--text-muted2)] text-xs mb-3">Due but not in today's schedule. Tap + Add to slot them into a day.</p>
            {unscheduled.map(s => (
              <div key={s.store_id} className="py-3 border-t border-[var(--bg-input)]/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[var(--text-primary)] text-sm font-medium">{s.name}</div>
                    <div className="text-[var(--text-muted2)] text-xs mt-0.5">
                      {s.skuReqs.map(r => `${r.name}: ${r.qty}`).join(' · ')} · due {s.due_date}
                    </div>
                    <div className="text-[var(--text-gold)] text-xs mt-1">{s.skipReason}</div>
                  </div>
                  <div className="shrink-0">
                    <select defaultValue=""
                      onChange={e => {
                        const day = Number(e.target.value)
                        if (isNaN(day) || e.target.value === '') return
                        const storeToAdd = { ...s, skuReqs: s.skuReqs.map(r => ({ ...r, requested: r.requested ?? r.qty })) }
                        setDueStores(prev => [...prev, storeToAdd])
                        setAssignment(a => ({ ...a, [s.store_id]: day }))
                        setUnscheduled(prev => prev.filter(x => x.store_id !== s.store_id))
                        setShowSkipped(false)
                      }}
                      className="bg-[var(--accent)] text-white text-xs rounded-xl px-3 py-2 outline-none cursor-pointer">
                      <option value="">+ Add to day</option>
                      {Array.from({ length: NUM_DAYS }).map((_, d) => (
                        <option key={d} value={d}>
                          {dayLabel(planDates[d] || dateForOffset(d), { short: true })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}

    {showAddStore && createPortal(
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col justify-end pb-20"
          onClick={() => setShowAddStore(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-[var(--bg-card)] border-t border-[var(--bg-input)]/60 rounded-t-2xl w-full shadow-2xl flex flex-col" style={{maxHeight:'80dvh'}}>
            <div className="px-4 py-3 border-b border-[var(--bg-input)]/40 flex items-center justify-between shrink-0">
              <span className="text-[var(--text-primary)] text-sm font-semibold">Add store to schedule</span>
              <button onClick={() => setShowAddStore(false)} className="text-[var(--text-muted)]">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              {(() => {
                const selectedStore = unscheduled.find(s => s.store_id === addStoreQtys['_selected'])
                  || dueStores.find(s => s.store_id === addStoreQtys['_selected'])
                  || (() => { const s = allStores.find(s => s.id === addStoreQtys['_selected']); return s ? { store_id: s.id, name: s.name, skuReqs: [], skipReason: null } : null })()

                if (!selectedStore) {
                  // Step 1: Search and pick a store — show skipped + all active stores (not dropped)
                  const scheduledIds = new Set(dueStores.map(s => s.store_id))
                  const unscheduledIds = new Set(unscheduled.map(s => s.store_id))

                  // Merge: skipped stores first (with reason), then all other active stores
                  const otherStores = allStores
                    .filter(s => !scheduledIds.has(s.id) && !unscheduledIds.has(s.id))
                    .map(s => ({ store_id: s.id, name: s.name, skipReason: null, due_date: null, skuReqs: [] }))

                  const allCandidates = [...unscheduled, ...otherStores]
                  const q = addStoreQuery.trim()
                  const candidates = q
                    ? allCandidates.filter(s => fuzzyMatch(q, s.name))
                    : allCandidates

                  return (
                    <>
                      <input autoFocus value={addStoreQuery} onChange={e => setAddStoreQuery(e.target.value)}
                        placeholder="Search stores..."
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />
                      {candidates.length === 0 && <p className="text-[var(--text-muted2)] text-xs text-center mt-4">No stores match.</p>}
                      {candidates.map(s => (
                        <button key={s.store_id} onClick={() => setAddStoreQtys(q => ({ '_selected': s.store_id }))}
                          className="w-full text-left bg-[var(--bg-input)]/40 hover:bg-[var(--bg-input)] rounded-xl px-4 py-3 mb-2 transition-colors">
                          <div className="text-[var(--text-primary)] text-sm font-medium">{s.name}</div>
                          <div className="text-[var(--text-muted2)] text-xs mt-0.5">
                            {s.skipReason ? <span className="text-[var(--text-gold)]">{s.skipReason}</span> : <span>Not in this week's schedule</span>}
                            {s.due_date && <span> · due {s.due_date}</span>}
                          </div>
                        </button>
                      ))}
                    </>
                  )
                }

                // Step 2: Store selected
                const skuMap = {}
                selectedStore.skuReqs.forEach(r => { skuMap[r.sku_id] = r.name })
                Object.keys({ ...availableStock, ...spareStock }).forEach(id => {
                  if (!skuMap[id]) {
                    const found = dueStores.flatMap(s => s.skuReqs).find(r => r.sku_id === id)
                    if (found) skuMap[id] = found.name
                  }
                })
                const addedKeys = Object.keys(addStoreQtys).filter(k => k.startsWith('sku-'))
                const addedSkuIds = addedKeys.map(k => k.replace('sku-', ''))
                const remainingSkuIds = Object.keys(skuMap).filter(id => !addedSkuIds.includes(id))

                return (
                  <>
                    <button onClick={() => setAddStoreQtys({})} className="text-[var(--accent)] text-xs mb-3">← Back</button>
                    <div className="text-[var(--text-primary)] text-base font-semibold mb-4">{selectedStore.name}</div>

                    {/* Added SKU lines */}
                    {addedKeys.map(key => {
                      const skuId = key.replace('sku-', '')
                      const totalRegular = availableStock[skuId] || 0
                      const allocated = dueStores.reduce((n, s2) => {
                        const k2 = `${s2.store_id}-${skuId}`
                        return n + (qtyOverrides[k2] !== undefined ? Number(qtyOverrides[k2]) : (s2.skuReqs.find(r2 => r2.sku_id === skuId)?.qty || 0))
                      }, 0)
                      const unalloc = totalRegular - allocated
                      const spare = spareStock[skuId] || 0
                      const maxQty = totalRegular + spare // allow using all stock, warn if overallocating
                      return (
                        <div key={key} className="bg-[var(--bg-input)]/40 rounded-xl p-3 mb-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[var(--text-secondary)] text-sm font-medium">{skuMap[skuId]}</span>
                            <button onClick={() => setAddStoreQtys(q => { const n = {...q}; delete n[key]; return n })}
                              className="text-[var(--text-muted2)] hover:text-red-400 text-xs">✕</button>
                          </div>
                          <div className="flex gap-3 text-xs text-[var(--text-muted2)] mb-2 flex-wrap">
                            <span>
                              Main batch: <span className="text-[var(--text-secondary)]">{totalRegular} pcs</span>
                              {unalloc > 0
                                ? <span className="text-[var(--accent)]"> · {unalloc} free</span>
                                : <span className="text-red-400"> · fully allocated</span>}
                            </span>
                            {spare > 0 && <span>Spare: <span className="text-[var(--text-gold)]">{spare} pcs</span></span>}
                          </div>
                          <input
                            type="number"
                            min="0"
                            value={addStoreQtys[key] || ''}
                            placeholder="0"
                            onChange={e => setAddStoreQtys(q => ({ ...q, [key]: e.target.value }))}
                            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-4 py-2.5 text-base font-semibold outline-none focus:ring-2 focus:ring-[var(--accent)] text-center" />
                        </div>
                      )
                    })}

                    {/* Add SKU button */}
                    {remainingSkuIds.length > 0 && (
                      <div className="mb-4">
                        {addStoreQtys['_picking'] ? (
                          <div className="bg-[var(--bg-input)]/40 rounded-xl overflow-hidden">
                            {remainingSkuIds.map(id => {
                              const avail = Math.max(0, (availableStock[id] || 0) - dueStores.reduce((n, s2) => {
                                const k2 = `${s2.store_id}-${id}`
                                return n + (qtyOverrides[k2] !== undefined ? Number(qtyOverrides[k2]) : (s2.skuReqs.find(r2 => r2.sku_id === id)?.qty || 0))
                              }, 0)) + (spareStock[id] || 0)
                              return (
                                <button key={id} onClick={() => setAddStoreQtys(q => { const n = {...q}; delete n['_picking']; return {...n, [`sku-${id}`]: ''} })}
                                  className="w-full flex items-center justify-between px-4 py-3 border-b border-[var(--bg-input)]/40 last:border-0 text-left hover:bg-[var(--bg-input)]/60 transition-colors">
                                  <span className="text-[var(--text-primary)] text-sm">{skuMap[id]}</span>
                                  <span className="text-[var(--text-muted2)] text-xs">{avail > 0 ? `${avail} pcs` : 'no stock'}</span>
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <button onClick={() => setAddStoreQtys(q => ({ ...q, '_picking': true }))}
                            className="w-full py-2.5 rounded-xl border border-dashed border-[var(--bg-input)] text-[var(--text-muted2)] text-sm hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                            + Add product
                          </button>
                        )}
                      </div>
                    )}

                    {/* Day picker */}
                    <div className="mb-4">
                      <label className="text-[var(--text-muted)] text-xs mb-2 block">Add to day</label>
                      <div className="flex flex-wrap gap-2">
                        {Array.from({ length: NUM_DAYS }).map((_, d) => {
                          const selected = (addStoreQtys['_day'] ?? 0) === d
                          return (
                            <button key={d} onClick={() => setAddStoreQtys(q => ({ ...q, '_day': d }))}
                              className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${selected ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-input)] text-[var(--text-secondary)]'}`}>
                              {dayLabel(planDates[d] || dateForOffset(d), { short: true })}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <button onClick={async () => {
                      const day = addStoreQtys['_day'] ?? 0
                      const newOverrides = {}
                      // Build skuReqs: start from forecast, then add any SKUs picked in the modal
                      const existingSkuIds = new Set(selectedStore.skuReqs.map(r => r.sku_id))
                      const extraSkuReqs = addedKeys
                        .map(key => key.replace('sku-', ''))
                        .filter(skuId => !existingSkuIds.has(skuId))
                        .map(skuId => ({ sku_id: skuId, name: skuMap[skuId] || skuId, qty: 0, requested: 0 }))
                      const storeToAdd = {
                        ...selectedStore,
                        skuReqs: [
                          ...selectedStore.skuReqs.map(r => ({ ...r, qty: 0, requested: 0 })),
                          ...extraSkuReqs
                        ]
                      }
                      addedKeys.forEach(key => {
                        const skuId = key.replace('sku-', '')
                        const val = addStoreQtys[key]
                        if (val !== undefined && val !== '' && Number(val) > 0)
                          newOverrides[`${selectedStore.store_id}-${skuId}`] = Number(val)
                      })
                      const nextOverrides = { ...qtyOverrides, ...newOverrides }
                      const nextDueStores = [...dueStores, storeToAdd]
                      const nextAssignment = { ...assignment, [selectedStore.store_id]: day }
                      setQtyOverrides(nextOverrides)
                      setDueStores(nextDueStores)
                      setAssignment(nextAssignment)
                      setUnscheduled(prev => prev.filter(x => x.store_id !== selectedStore.store_id))
                      setShowAddStore(false)
                      setAddStoreQtys({})
                      setHasUnsavedChanges(true)
                      setSaved(false)
                    }}
                      className="w-full py-3 rounded-xl bg-[var(--accent)] text-white text-sm font-semibold">
                      {addedKeys.some(k => Number(addStoreQtys[k]) > 0) ? 'Confirm delivery' : 'Add as visit only'}
                    </button>
                  </>
                )
              })()}
            </div>
          </div>
        </div>,
        document.body
      )}

    {showPickupDetail && createPortal(
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col"
          onClick={() => setShowPickupDetail(false)}>
          <div onClick={e => e.stopPropagation()}
            className="m-4 mt-16 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-4 max-h-[70vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[var(--text-primary)] text-sm font-semibold">Collecting from depot</span>
              <button onClick={() => setShowPickupDetail(false)} className="text-[var(--text-muted)]">✕</button>
            </div>
            {pickupDue.map(s => (
              <div key={s.store_id} className="py-2 border-t border-[var(--bg-input)]/40">
                <div className="text-[var(--text-secondary)] text-sm">{s.name}</div>
                <div className="text-[var(--text-muted2)] text-xs mt-0.5">
                  {s.skuReqs.map(r => `${r.name}: ${r.qty} pcs`).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
