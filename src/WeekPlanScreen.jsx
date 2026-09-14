import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { useSettings } from './useSettings'
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
  return d.toISOString().slice(0, 10)
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
  const [showPickupDetail, setShowPickupDetail] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [stalePlans, setStalePlans] = useState([])
  const [matrixMap, setMatrixMap] = useState({})
  const [matrixMeters, setMatrixMeters] = useState({})
  const [depotId, setDepotId] = useState(null)

  async function load() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()

    const todayStr = new Date().toISOString().slice(0, 10)
    const { data: existingPlans } = await supabase.from('plans')
      .select('plan_date, plan_stops(store_id)')
      .eq('user_id', user.id)
      .gte('plan_date', planDates[0] || todayStr)
      .lt('plan_date', todayStr)
    setStalePlans(existingPlans || [])

    const [{ data: forecast }, { data: stores }, { data: matrix }] = await Promise.all([
      supabase.from('store_sku_forecast').select('*'),
      supabase.from('stores').select('id, name, lat, lng, service_minutes, is_depot, is_pickup').eq('is_active', true),
      supabase.from('travel_matrix').select('from_store_id, to_store_id, seconds, meters'),
    ])

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
    setPickupDue(allDue.filter(s => s.is_pickup))

    // Greedy day assignment: sort by due date, then bearing (cluster direction)
    stores_due.sort((a, b) => {
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

    stores_due.forEach(s => {
      const rawDue = daysUntil(s.due_date)
      // Already overdue: one more day changes little, so let it land anywhere in
      // the week rather than forcing every overdue store onto Day 1.
      const overdue = rawDue < 0
      const dueDay = overdue ? NUM_DAYS - 1 : Math.max(0, Math.min(NUM_DAYS - 1, rawDue))
      let placed = false
      for (let day = 0; day <= dueDay; day++) {
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
      // Fits nowhere inside the working day: leave it unscheduled rather than
      // pretending a day can absorb it.
      if (!placed) overflow.push(s)
    })

    setMatrixMap(matrixMap)
    setMatrixMeters(metersMap)
    setDepotId(depot.id)
    setUnscheduled(overflow)
    // Ignore saved assignments from before today — they're stale and would
    // override the fresh computation with yesterday's plan.
    const staleIds = new Set()
    ;(existingPlans || []).filter(p => p.plan_date < todayStr).forEach(p => {
      ;(p.plan_stops || []).forEach(ps => staleIds.add(ps.store_id))
    })
    stores_due.forEach(s => { if (staleIds.has(s.store_id)) delete assign[s.store_id] })

    setDueStores(stores_due)
    setAssignment(assign)
    setLoading(false)
  }

  useEffect(() => { if (settingsLoaded) load() }, [settingsLoaded, NUM_DAYS, DAILY_BUDGET_MIN, planDates.join(',')])

  function moveStore(storeId, newDay) {
    setAssignment(a => ({ ...a, [storeId]: newDay }))
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

  // Recomputed on every change: route each day depot -> stops -> depot using
  // real matrix legs, plus service time at each stop.
  const dayKm = useMemo(() => {
    const m = (a, b) => (a === b ? 0 : (matrixMeters[`${a}_${b}`] ?? matrixMeters[`${b}_${a}`] ?? 5000))
    return byDay.map(stops => {
      if (!stops.length || !depotId) return 0
      let meters = 0
      let prev = depotId
      stops.forEach(s => { meters += m(prev, s.store_id); prev = s.store_id })
      meters += m(prev, depotId)
      return Math.round(meters / 100) / 10
    })
  }, [byDay, matrixMeters, depotId])

  const dayMinutes = useMemo(() => {
    const leg = (a, b) => matrixMap[`${a}_${b}`] ?? matrixMap[`${b}_${a}`] ?? 600
    return byDay.map(stops => {
      if (!stops.length || !depotId) return 0
      let seconds = 0
      let prev = depotId
      stops.forEach(s => { seconds += leg(prev, s.store_id); prev = s.store_id })
      seconds += leg(prev, depotId)
      const service = stops.reduce((a, s) => a + (s.service_minutes || 15), 0)
      return Math.round(seconds / 60 + service)
    })
  }, [byDay, matrixMap, depotId])

  const leg = (a, b) => (a === b ? 0 : (matrixMap[`${a}_${b}`] ?? matrixMap[`${b}_${a}`] ?? 600))

  // Order each day depot -> ... -> depot by nearest neighbour, so that
  // insertion positions below mean something.
  const dayRoutes = useMemo(() => {
    if (!depotId) return byDay.map(() => [])
    return byDay.map(stops => {
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
      return out
    })
  }, [byDay, matrixMap, depotId])

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
    load() // recompute from scratch
  }

  async function saveWeekPlan() {
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

    const wanted = new Set()
    dates.forEach((date, day) => {
      (byDay[day] || []).forEach(s => wanted.add(`${planIdByDate[date]}_${s.store_id}`))
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
      ;(byDay[day] || []).forEach((s, idx) => {
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
      ;(byDay[day] || []).forEach(s => {
        const stopId = stopIdByKey[`${planId}_${s.store_id}`]
        if (!stopId) return
        s.skuReqs.forEach(r => {
          reqRows.push({ plan_stop_id: stopId, sku_id: r.sku_id, proposed_qty: r.qty, approved_qty: r.qty, source: 'auto' })
        })
      })
    })
    if (reqRows.length) {
      await supabase.from('requirements').upsert(reqRows, { onConflict: 'plan_stop_id,sku_id' })
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
            <button onClick={resetPlan} disabled={resetting}
              className={`text-xs disabled:opacity-50 transition-colors font-medium ${stale ? 'text-red-400 hover:text-red-300' : 'text-[var(--text-muted2)] hover:text-[var(--text-primary)]'}`}>
              {resetting ? 'Resetting...' : stale ? '⚠ Reset & recompute' : 'Reset & recompute'}
            </button>
          )
        })()}
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-5">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Computing assignments...</div>}

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
            {showPickupDetail && (
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
              </div>
            )}
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
                  <div key={s.store_id} className="bg-[var(--bg-card)] rounded-xl p-3 flex items-center gap-3">
                    <button onClick={() => toggleLock(s.store_id)} className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] shrink-0">
                      {locked[s.store_id] ? <Lock size={14} className="text-[var(--text-gold)]" /> : <Unlock size={14} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--text-primary)] text-sm truncate">{s.name}</div>
                      <div className="text-[var(--text-muted2)] text-xs">
                        {s.skuReqs.map(r => `${r.name}: ${r.qty}`).join(' · ')}
                        {' · due '}{s.due_date}
                      </div>
                    </div>
                    <select
                      value={assignment[s.store_id] ?? 0}
                      onChange={e => moveStore(s.store_id, Number(e.target.value))}
                      disabled={locked[s.store_id]}
                      className="bg-[var(--bg-input)] text-[var(--text-primary)] text-xs rounded-lg px-2 py-1.5 outline-none disabled:opacity-40 shrink-0"
                    >
                      {moveImpact(s).map(({ day: d, cost, current, late }) => (
                        <option key={d} value={d}>
                          {dayLabel(planDates[d] || dateForOffset(d), { short: true })}{current ? '' : ` +${cost}m`}{late ? ' ⚠' : ''}
                        </option>
                      ))}
                    </select>
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
            onClick={saveWeekPlan}
            disabled={saving || saved}
            className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors"
          >
            {saved ? <><CheckCircle size={18} /> Week plan saved!</> : saving ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : 'Save Week Plan'}
          </button>
        </div>
      )}
    </div>
  )
}
