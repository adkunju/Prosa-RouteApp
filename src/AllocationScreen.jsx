import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { computeProposedQty } from './forecastMath'
import { Package, CheckCircle, ChevronDown } from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)

export default function AllocationScreen() {
  const [rows, setRows] = useState([])
  const [qtys, setQtys] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [planDate, setPlanDate] = useState(today())
  const [horizon, setHorizon] = useState(1) // days ahead to include as "due"

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('store_sku_forecast').select('*')
    setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Days from the chosen plan date to the due date. Both parsed as local
  // midnight so the difference is a whole number of days, no timezone skew.
  function daysUntil(dateStr, from = planDate) {
    if (!dateStr) return Infinity
    const target = new Date(dateStr + 'T00:00:00')
    const base = new Date(from + 'T00:00:00')
    return Math.round((target - base) / 86400000)
  }

  const dueRows = rows
    .filter(r => daysUntil(r.next_visit_due) <= horizon)
    .map(r => ({ ...r, ...computeProposedQty(r) }))
    .sort((a, b) => daysUntil(a.next_visit_due) - daysUntil(b.next_visit_due))

  function getQty(row) {
    const key = `${row.store_id}-${row.sku_id}`
    return qtys[key] !== undefined ? qtys[key] : row.proposed
  }

  function setQty(row, val) {
    const key = `${row.store_id}-${row.sku_id}`
    setQtys(q => ({ ...q, [key]: val }))
  }

  const totalsBySku = dueRows.reduce((acc, row) => {
    const qty = Number(getQty(row)) || 0
    acc[row.sku_name] = (acc[row.sku_name] || 0) + qty
    return acc
  }, {})

  async function createPlan() {
    if (saving || saved) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()

    let planId
    const { data: existing } = await supabase
      .from('plans').select('id').eq('user_id', user.id).eq('plan_date', planDate).maybeSingle()
    if (existing) {
      planId = existing.id
    } else {
      const { data: np } = await supabase.from('plans')
        .insert({ user_id: user.id, plan_date: planDate, status: 'draft' })
        .select('id').single()
      planId = np?.id
    }

    // Group rows by store
    const byStore = {}
    dueRows.forEach(row => {
      if (!byStore[row.store_id]) byStore[row.store_id] = []
      byStore[row.store_id].push(row)
    })

    const { count } = await supabase.from('plan_stops').select('id', { count: 'exact', head: true }).eq('plan_id', planId)
    let stopOrder = (count || 0) + 1

    for (const storeId of Object.keys(byStore)) {
      // Check for an existing stop for this store on this plan (idempotent)
      const { data: existingStop } = await supabase.from('plan_stops')
        .select('id').eq('plan_id', planId).eq('store_id', storeId).maybeSingle()

      let stopId
      if (existingStop) {
        stopId = existingStop.id
      } else {
        const { data: stop } = await supabase.from('plan_stops')
          .insert({ plan_id: planId, store_id: storeId, stop_order: stopOrder })
          .select('id').single()
        stopOrder++
        if (!stop) continue
        stopId = stop.id
      }

      for (const row of byStore[storeId]) {
        const approvedQty = Number(getQty(row))
        // Check for existing requirement for this stop+sku, update instead of duplicating
        const { data: existingReq } = await supabase.from('requirements')
          .select('id').eq('plan_stop_id', stopId).eq('sku_id', row.sku_id).maybeSingle()

        if (existingReq) {
          await supabase.from('requirements').update({
            proposed_qty: row.proposed, approved_qty: approvedQty,
          }).eq('id', existingReq.id)
        } else {
          await supabase.from('requirements').insert({
            plan_stop_id: stopId, sku_id: row.sku_id,
            proposed_qty: row.proposed, approved_qty: approvedQty, source: 'auto',
          })
        }
      }
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-3 shrink-0">
        <input type="date" value={planDate} onChange={e => setPlanDate(e.target.value)}
          className="bg-[var(--bg-card)] text-[var(--text-primary)] text-sm rounded-lg px-2 py-1.5 outline-none" />
        <select value={horizon} onChange={e => setHorizon(Number(e.target.value))}
          className="bg-[var(--bg-card)] text-[var(--text-secondary)] text-xs rounded-lg px-2 py-1.5 outline-none flex-1">
          <option value={0}>Due today or overdue</option>
          <option value={1}>Due within 1 day</option>
          <option value={2}>Due within 2 days</option>
          <option value={3}>Due within 3 days</option>
        </select>
      </div>

      <div className="px-4 py-3 bg-[var(--bg-card)]/60 border-b border-[var(--bg-input)] shrink-0">
        <div className="text-xs text-[var(--text-muted)] mb-1">Today's production target</div>
        <div className="flex flex-wrap gap-3">
          {Object.entries(totalsBySku).length === 0 && <span className="text-[var(--text-muted2)] text-sm">No stores due</span>}
          {Object.entries(totalsBySku).map(([sku, qty]) => (
            <div key={sku} className="text-[var(--text-primary)] text-sm font-semibold">
              {sku}: <span className="text-[var(--text-accent)]">{qty} pcs</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Loading...</div>}
        {!loading && dueRows.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No stores due in this window</p>
          </div>
        )}
        {dueRows.map(row => (
          <div key={`${row.store_id}-${row.sku_id}`} className="bg-[var(--bg-card)] rounded-xl p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="min-w-0 flex-1">
                <div className="text-[var(--text-primary)] text-sm font-medium truncate">{row.store_name}</div>
                <div className="text-[var(--text-muted)] text-xs mt-0.5">{row.sku_name}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[var(--text-muted2)] text-xs">proposed</span>
                <span className="text-[var(--text-accent)] font-semibold text-sm">{row.proposed}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <label className="text-[var(--text-muted)] text-xs">Approve qty:</label>
              <input
                type="number"
                value={getQty(row)}
                onChange={e => setQty(row, e.target.value)}
                className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-1.5 text-sm w-20 outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
              <span className="text-[var(--text-faint)] text-xs ml-auto">
                rate {row.avg_daily_rate}/d · CR {row.criticalRatio}% · z {row.z}
              </span>
            </div>
          </div>
        ))}
      </div>

      {dueRows.length > 0 && (
        <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
          <button
            onClick={createPlan}
            disabled={saving || saved}
            className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors"
          >
            {saved ? <><CheckCircle size={18} /> Plan created!</> : saving ? 'Saving...' : `Create Plan for ${planDate}`}
          </button>
        </div>
      )}
    </div>
  )
}
