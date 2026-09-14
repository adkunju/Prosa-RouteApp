import { useEffect, useState, useMemo } from 'react'
import { supabase } from './supabaseClient'
import { useSettings } from './useSettings'
import { computeProposedQty, bearingFromDepot } from './forecastMath'
import { Calendar, Lock, Unlock, AlertTriangle, CheckCircle, Loader2, Package } from 'lucide-react'

const NUM_DAYS = 6
const DAILY_BUDGET_MIN = 360 // 6 hours

function dateForOffset(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
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
  const NUM_DAYS = settings.delivery_days_per_week
  const DAILY_BUDGET_MIN = settings.daily_budget_min
  const [locked, setLocked] = useState({}) // storeId -> bool
  const [pickupDue, setPickupDue] = useState([])
  const [matrixMap, setMatrixMap] = useState({})
  const [depotId, setDepotId] = useState(null)

  async function load() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()

    const [{ data: forecast }, { data: stores }, { data: matrix }] = await Promise.all([
      supabase.from('store_sku_forecast').select('*'),
      supabase.from('stores').select('id, name, lat, lng, service_minutes, is_depot, is_pickup').eq('is_active', true),
      supabase.from('travel_matrix').select('from_store_id, to_store_id, seconds'),
    ])

    const depot = stores.find(s => s.is_depot)
    const matrixMap = {}
    matrix.forEach(m => { matrixMap[`${m.from_store_id}_${m.to_store_id}`] = m.seconds })

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
      if (!placed) {
        // Nothing fits inside the budget: put it on the emptiest eligible day
        // instead of stacking everything on one, so the overflow is spread and
        // visible rather than hidden in a single impossible day.
        let best = 0
        for (let day = 1; day <= dueDay; day++) {
          if (dayMins[day] < dayMins[best]) best = day
        }
        dayLists[best].push(s.store_id)
        dayMins[best] += s.service_minutes + 20
        assign[s.store_id] = best
      }
    })

    setMatrixMap(matrixMap)
    setDepotId(depot.id)
    setDueStores(stores_due)
    setAssignment(assign)
    setLoading(false)
  }

  useEffect(() => { if (settingsLoaded) load() }, [settingsLoaded, NUM_DAYS, DAILY_BUDGET_MIN])

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

  async function saveWeekPlan() {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()

    for (let day = 0; day < NUM_DAYS; day++) {
      const stops = byDay[day]
      if (stops.length === 0) continue
      const planDate = dateForOffset(day)

      let planId
      const { data: existing } = await supabase.from('plans').select('id').eq('user_id', user.id).eq('plan_date', planDate).maybeSingle()
      if (existing) { planId = existing.id } else {
        const { data: np } = await supabase.from('plans').insert({ user_id: user.id, plan_date: planDate, status: 'draft' }).select('id').single()
        planId = np?.id
      }
      const { count } = await supabase.from('plan_stops').select('id', { count: 'exact', head: true }).eq('plan_id', planId)
      let stopOrder = (count || 0) + 1

      for (const s of stops) {
        const { data: existingStop } = await supabase.from('plan_stops')
          .select('id').eq('plan_id', planId).eq('store_id', s.store_id).maybeSingle()

        let stopId
        if (existingStop) {
          stopId = existingStop.id
        } else {
          const { data: stop } = await supabase.from('plan_stops').insert({ plan_id: planId, store_id: s.store_id, stop_order: stopOrder }).select('id').single()
          stopOrder++
          if (!stop) continue
          stopId = stop.id
        }

        for (const req of s.skuReqs) {
          const { data: existingReq } = await supabase.from('requirements')
            .select('id').eq('plan_stop_id', stopId).eq('sku_id', req.sku_id).maybeSingle()
          if (existingReq) {
            await supabase.from('requirements').update({ proposed_qty: req.qty, approved_qty: req.qty }).eq('id', existingReq.id)
          } else {
            await supabase.from('requirements').insert({
              plan_stop_id: stopId, sku_id: req.sku_id, proposed_qty: req.qty, approved_qty: req.qty, source: 'auto',
            })
          }
        }
      }
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
        <span className="text-[var(--text-muted2)] text-xs">Budget: {DAILY_BUDGET_MIN / 60}h/day</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-5">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Computing assignments...</div>}

        {!loading && pickupDue.length > 0 && (
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--text-gold)]/30 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--text-primary)] text-sm font-medium flex items-center gap-2">
                <Package size={14} className="text-[var(--text-gold)]" /> Collecting from depot
              </span>
              <span className="text-[var(--text-muted2)] text-xs">{pickupDue.length} stores</span>
            </div>
            <p className="text-[var(--text-muted2)] text-xs mb-3">Not route stops — box these up for collection.</p>
            {pickupDue.map(s => (
              <div key={s.store_id} className="flex items-start justify-between py-1.5 border-t border-[var(--bg-input)]/40">
                <span className="text-[var(--text-secondary)] text-xs">{s.name}</span>
                <span className="text-[var(--text-muted)] text-xs text-right shrink-0 ml-3">
                  {s.skuReqs.map(r => `${r.name}: ${r.qty}`).join(' · ')}
                </span>
              </div>
            ))}
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
                  Day {day + 1} — {dateForOffset(day)}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${overloaded ? 'bg-red-900/60 text-red-300' : 'bg-[var(--bg-input)] text-[var(--text-secondary)]'}`}>
                  {formatDuration(mins)} · {stops.length} stops
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
                      {Array.from({ length: NUM_DAYS }).map((_, d) => (
                        <option key={d} value={d}>Day {d + 1}</option>
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
