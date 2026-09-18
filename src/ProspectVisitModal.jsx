import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { X, Clock } from 'lucide-react'

export default function ProspectVisitModal({ planId, stops, onClose, onAdded, depot, matrixSeconds }) {
  const [prospects, setProspects] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(null)
  const [visitDate, setVisitDate] = useState(new Date().toLocaleDateString('en-CA'))
  const [added, setAdded] = useState(new Set())

  useEffect(() => {
    ;(async () => {
      const [{ data: stores }, { data: summary }] = await Promise.all([
        supabase.from('stores')
          .select('id, name, pipeline_status')
          .eq('is_active', true)
          .eq('is_depot', false)
          .not('pipeline_status', 'in', '("onboard","dropped")')
          .order('name'),
        supabase.from('store_sales_summary')
          .select('store_id, last_visit, days_since_visit, visit_count'),
      ])
      const summaryMap = {}
      ;(summary || []).forEach(s => { summaryMap[s.store_id] = s })
      const todayIds = new Set((stops || []).map(s => s.store_id))
      const list = (stores || [])
        .filter(s => !todayIds.has(s.id))
        .map(s => ({ ...s, ...summaryMap[s.id] }))
        .sort((a, b) => {
          const da = a.days_since_visit ?? 9999
          const db = b.days_since_visit ?? 9999
          return db - da
        })
      setProspects(list)
      setLoading(false)
    })()
  }, [])

  async function addVisit(store) {
    if (!planId || adding) return
    setAdding(store.id)
    // Find the plan for the selected date
    const { data: plan } = await supabase.from('plans')
      .select('id').eq('plan_date', visitDate).maybeSingle()
    const targetPlanId = plan?.id || planId
    const { data: existingStops } = await supabase.from('plan_stops')
      .select('stop_order').eq('plan_id', targetPlanId).order('stop_order', { ascending: false }).limit(1)
    const maxOrder = existingStops?.[0]?.stop_order || 0
    await supabase.from('plan_stops').insert({
      plan_id: targetPlanId,
      store_id: store.id,
      stop_order: maxOrder + 1,
    })
    setAdding(null)
    setAdded(a => new Set([...a, store.id]))
    onAdded()
  }

  async function removeVisit(store) {
    // Remove from today's plan stops if present
    const { data: plan } = await supabase.from('plans')
      .select('id').eq('plan_date', visitDate).maybeSingle()
    if (!plan) return
    await supabase.from('plan_stops')
      .delete()
      .eq('plan_id', plan.id)
      .eq('store_id', store.id)
    onAdded()
  }

  const statusLabel = { prospect: 'Prospect', warm: 'Warm', cold: 'Cold', dormant: 'Dormant' }
  const statusColor = {
    prospect: 'text-[var(--accent)] bg-[var(--accent)]/10',
    warm: 'text-[var(--text-gold)] bg-[var(--text-gold)]/10',
    cold: 'text-[var(--text-muted2)] bg-[var(--bg-input)]',
    dormant: 'text-red-400 bg-red-400/10',
  }

  function timeImpactMin(storeId) {
    if (!depot || !matrixSeconds) return null
    const depotId = depot.id
    const leg = (a, b) => matrixSeconds[`${a}_${b}`] ?? matrixSeconds[`${b}_${a}`] ?? null
    // Find cheapest insertion: min(leg(depot→store) + leg(store→first)) or just leg(last→store) + leg(store→depot)
    const storeStops = (stops || []).map(s => s.store_id)
    if (storeStops.length === 0) {
      const there = leg(depotId, storeId)
      const back = leg(storeId, depotId)
      return there != null && back != null ? Math.round((there + back) / 60) : null
    }
    let minCost = Infinity
    const seq = [depotId, ...storeStops, depotId]
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1]
      const toStore = leg(a, storeId)
      const fromStore = leg(storeId, b)
      const existing = leg(a, b)
      if (toStore != null && fromStore != null && existing != null) {
        const cost = toStore + fromStore - existing
        if (cost < minCost) minCost = cost
      }
    }
    return minCost === Infinity ? null : Math.round(Math.max(0, minCost) / 60)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
        <div>
          <span className="text-[var(--text-primary)] font-semibold">Visit Prospects</span>
          <p className="text-[var(--text-muted2)] text-xs mt-0.5">Non-onboarded stores · sorted by days since last visit</p>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X size={20} />
        </button>
      </div>
      <div className="px-4 py-2 border-b border-[var(--bg-input)]/40 shrink-0 flex items-center gap-3">
        <span className="text-[var(--text-muted)] text-xs shrink-0">Visit date</span>
        <input type="date" value={visitDate}
          onChange={e => setVisitDate(e.target.value)}
          className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] text-sm rounded-lg px-3 py-1.5 outline-none" />
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {loading && <p className="text-[var(--text-muted2)] text-sm text-center mt-16">Loading...</p>}
        {!loading && prospects.length === 0 && (
          <p className="text-[var(--text-muted2)] text-sm text-center mt-16">No prospects in the system yet</p>
        )}
        {prospects.map(s => {
          const isAdded = added.has(s.id)
          return (
            <div key={s.id} className={`bg-[var(--bg-card)] rounded-xl p-4 flex items-center gap-3 ${isAdded ? 'opacity-70' : ''}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${statusColor[s.pipeline_status] || 'text-[var(--text-muted2)] bg-[var(--bg-input)]'}`}>
                    {statusLabel[s.pipeline_status] || s.pipeline_status}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--text-muted2)] text-xs">
                  <Clock size={11} />
                  {s.days_since_visit != null
                    ? <span>{s.days_since_visit}d since last visit · {s.visit_count} total</span>
                    : <span className="text-[var(--text-gold)]">Never visited</span>
                  }
                  {timeImpactMin(s.id) != null && (
                    <span className="ml-1 text-[var(--text-muted)] bg-[var(--bg-input)] px-1.5 py-0.5 rounded">
                      +{timeImpactMin(s.id)}m
                    </span>
                  )}
                </div>
              </div>
              {isAdded ? (
                <button onClick={() => { removeVisit(s); setAdded(a => { const n = new Set(a); n.delete(s.id); return n }) }}
                  className="shrink-0 bg-[var(--bg-input)] text-red-400 text-xs font-semibold rounded-xl px-3 py-2 transition-colors hover:bg-red-400/20">
                  Remove
                </button>
              ) : (
                <button onClick={() => addVisit(s)} disabled={adding === s.id}
                  className="shrink-0 bg-[var(--accent)] disabled:opacity-50 text-white text-xs font-semibold rounded-xl px-3 py-2 transition-colors hover:opacity-90">
                  {adding === s.id ? '...' : '+ Add'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
