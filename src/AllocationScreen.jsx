import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { notifyStockChanged, confirmNoDuplicateBatch } from './stockUtils'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import { computeProposedQty } from './forecastMath'
import StoreHistoryModal from './StoreHistoryModal'
import { Package, CheckCircle, ChevronDown } from 'lucide-react'

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const today = () => localDate()

export default function AllocationScreen() {
  const [confirming, setConfirming] = useState(false)
  const [historyFor, setHistoryFor] = useState(null) // store whose delivery/return history is open
  const [confirmError, setConfirmError] = useState('')
  const [rows, setRows] = useState([])
  const [qtys, setQtys] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [planDate, setPlanDate] = useState(today())
  const [horizon, setHorizon] = useState(1)
  const phones = useStoreContacts()
  const [caps, setCaps] = useState({})        // sku_name -> capacity
  const [rationed, setRationed] = useState(null) // summary after applying
  const [showSkipped, setShowSkipped] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [spareQtys, setSpareQtys] = useState({}) // sku_name -> spare qty // days ahead to include as "due"

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('store_sku_forecast').select('*').neq('pipeline_status', 'dropped')
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

  const proposedBySku = dueRows.reduce((acc, row) => {
    acc[row.sku_name] = (acc[row.sku_name] || 0) + (Number(row.proposed) || 0)
    return acc
  }, {})

  // Ration a limited batch across stores: most urgent first, then fastest
  // selling. A store gets its full ask or nothing — a token drop looks bad on
  // the shelf and wastes stock that another store could have sold.
  function applyCapacity() {
    const next = { ...qtys }
    const summary = {}

    Object.entries(caps).forEach(([skuName, capRaw]) => {
      const cap = Number(capRaw)
      if (capRaw === '' || isNaN(cap)) return

      const rows = dueRows
        .filter(r => r.sku_name === skuName)
        .sort((a, b) => {
          const d = String(a.next_visit_due).localeCompare(String(b.next_visit_due))
          if (d !== 0) return d
  return (Number(b.avg_daily_rate) || 0) - (Number(a.avg_daily_rate) || 0)
        })

      let left = cap
      const served = [], cut = []
      rows.forEach(r => {
        const moq = Number(r.min_delivery_qty) || 1
        const want = Number(r.proposed) || 0
        const key = `${r.store_id}-${r.sku_id}`
        if (want <= 0) { next[key] = 0; return }
        if (left >= want) { next[key] = want; left -= want; served.push(r.store_name) }
        else if (left >= moq && left > 0) { next[key] = left; served.push(r.store_name + ' (short)'); left = 0 }
        else { next[key] = 0; cut.push(r.store_name) }
      })
      summary[skuName] = { cap, used: cap - left, served: served.length, cut }
    })

    setQtys(next)
    setRationed(summary)
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

  // Summary for confirm modal — group approved qtys by SKU name
  const skuNames = [...new Set(dueRows.map(r => r.sku_name))]
  const totalsForConfirm = skuNames.map(name => {
    const sample = dueRows.find(r => r.sku_name === name)
    const skuQty = dueRows
      .filter(r => r.sku_name === name)
      .reduce((s, r) => s + Number(getQty(r) || 0), 0)
    return {
      sku_name: name,
      sku_id: sample?.sku_id || null,
      shelf_days: sample?.shelf_life_days || 7,
      qty: skuQty,
    }
  }).filter(t => t.qty > 0)

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
        {Object.entries(totalsBySku).length === 0 ? (
          <span className="text-[var(--text-muted2)] text-sm">No stores due</span>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--text-muted2)]">
                <th className="text-left font-normal pb-1">Product</th>
                <th className="text-right font-normal pb-1">Making</th>
                <th className="text-right font-normal pb-1">Proposed</th>
                <th className="text-right font-normal pb-1">Approved</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(totalsBySku).map(([sku, qty]) => {
                const prop = proposedBySku[sku] || 0
                const diff = qty - prop
                return (
                  <tr key={sku} className="border-t border-[var(--bg-input)]/40">
                    <td className="text-[var(--text-secondary)] py-1.5">{sku}</td>
                    <td className="text-right py-1.5">
                      <input type="number" min="0" placeholder="all"
                        value={caps[sku] ?? ''}
                        onChange={e => setCaps(p => ({ ...p, [sku]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') applyCapacity() }}
                        className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-md px-1.5 py-1 text-xs w-14 text-right outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                    </td>
                    <td className="text-right text-[var(--text-muted)] py-1.5">{prop}</td>
                    <td className="text-right py-1.5">
                      <span className="text-[var(--text-accent)] font-semibold">{qty}</span>
                      {diff !== 0 && (
                        <span className={`ml-1 ${diff > 0 ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted2)]'}`}>
                          ({diff > 0 ? '+' : ''}{diff})
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <div className="flex items-center gap-2 mt-2">
          <button onClick={applyCapacity}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors">
            Apply limits
          </button>
          {rationed && (
            <button onClick={() => { setQtys({}); setCaps({}); setRationed(null) }}
              className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-xs px-2 py-1.5">Reset</button>
          )}
          {rationed && (() => {
            const total = Object.values(rationed).reduce((n, r) => n + r.cut.length, 0)
            if (total === 0) return null
            return (
              <button onClick={() => setShowSkipped(true)}
                className="text-[var(--text-gold)] hover:underline text-xs">
                {total} store{total > 1 ? 's' : ''} skipped
              </button>
            )
          })()}
        </div>
      </div>

      {showSkipped && rationed && (
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/70 backdrop-blur-xl flex items-center justify-center p-6"
          onClick={() => setShowSkipped(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl p-4 w-full max-w-sm max-h-[70vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[var(--text-primary)] text-sm font-semibold">Skipped today</span>
              <button onClick={() => setShowSkipped(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
            </div>
            {Object.entries(rationed).map(([sku, r]) => r.cut.length > 0 && (
              <div key={sku} className="mb-3">
                <div className="text-[var(--text-muted)] text-xs mb-1.5">{sku} · {r.cut.length}</div>
                {r.cut.map((n, i) => (
                  <div key={i} className="text-[var(--text-secondary)] text-sm py-1 border-t border-[var(--bg-input)]/40">
                    {String(n).replace(/,\s*/, ' - ')}
                  </div>
                ))}
              </div>
            ))}
            <p className="text-[var(--text-muted2)] text-xs mt-2">These stay due and move to the front of the queue next time.</p>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Loading...</div>}
        {!loading && dueRows.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No stores due in this window</p>
          </div>
        )}
        {dueRows.map(row => (
          <div key={`${row.store_id}-${row.sku_id}`} className="bg-[var(--bg-card)] rounded-xl p-3">
            <div className="flex items-start justify-between mb-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <button onClick={() => setHistoryFor({
                      storeId: row.store_id, storeName: row.store_name,
                      summary: [
                        row.avg_daily_rate != null && `Sells ~${Number(row.avg_daily_rate)}/day`,
                        row.avg_gap_days != null && `visit every ${Number(row.avg_gap_days)} days`,
                        row.recent_soldouts != null && `sold out ${row.recent_soldouts} of last 3${row.last_soldout ? ' (incl. latest)' : ''}`,
                      ].filter(Boolean).join(' · '),
                    })}
                    className="text-[var(--text-primary)] text-sm font-medium truncate text-left hover:text-[var(--text-accent)]">
                    {row.store_name}
                  </button>
                  {row.pipeline_status === 'dormant' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-[var(--text-gold)]/20 text-[var(--text-gold)] shrink-0">DORMANT</span>}
                  <ContactButtons phone={phones[row.store_id]} storeId={row.store_id} storeName={row.store_name} status={row.pipeline_status} />
                </div>
                <div className="text-[var(--text-muted)] text-xs mt-0.5">
                  {row.sku_name}
                  {row.last_visit_date && <span className="text-[var(--text-faint)]"> · last {row.last_visit_date}</span>}
                  {row.soldOutBoost && <span className="text-emerald-500"> · +1 (sold out lately)</span>}
                  {row.min_delivery_qty > 0 && row.proposed < row.min_delivery_qty && (
                    <span className="text-[var(--text-gold)]"> · below MOQ {row.min_delivery_qty} pcs</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[var(--text-muted2)] text-xs">proposed</span>
                <span className="text-[var(--text-accent)] font-semibold text-sm">{row.proposed}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <label className="text-[var(--text-muted)] text-xs">Approve qty:</label>
              <div className="flex items-center gap-1">
                <button onClick={() => setQty(row, Math.max(0, (Number(getQty(row)) || 0) - 1))}
                  className="w-8 h-8 rounded-lg bg-[var(--bg-input)] text-[var(--text-primary)] text-lg leading-none flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors">−</button>
                <input
                  type="number" min="0"
                  value={getQty(row)}
                  onChange={e => setQty(row, e.target.value)}
                  className={`bg-[var(--bg-input)] rounded-lg px-2 py-1.5 text-sm w-14 text-center outline-none focus:ring-2 focus:ring-[var(--accent)] ${Number(getQty(row)) === 0 ? 'text-[var(--text-muted2)] line-through' : 'text-[var(--text-primary)]'}`}
                />
                <button onClick={() => setQty(row, (Number(getQty(row)) || 0) + 1)}
                  className="w-8 h-8 rounded-lg bg-[var(--bg-input)] text-[var(--text-primary)] text-lg leading-none flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors">+</button>
                {Number(getQty(row)) !== 0 && (
                  <button onClick={() => setQty(row, 0)}
                    className="ml-1 text-[var(--text-muted2)] hover:text-red-400 text-[11px] px-1.5 py-1 rounded transition-colors">skip</button>
                )}
              </div>

            </div>
          </div>
        ))}
      </div>

      {dueRows.length > 0 && (
        <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
        <button
          onClick={() => { if (totalsForConfirm.length) setShowConfirm(true) }}
          disabled={Object.values(totalsBySku).every(q => !Number(q))}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors"
        >
          Confirm Production
        </button>
        </div>
      )}

      {historyFor && <StoreHistoryModal {...historyFor} onClose={() => setHistoryFor(null)} />}
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col justify-end pb-20"
          onClick={() => setShowConfirm(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-[var(--bg-card)] border-t border-[var(--bg-input)]/60 rounded-t-2xl w-full shadow-2xl flex flex-col" style={{maxHeight: 'min(80dvh, 600px)'}}>
            <div className="overflow-y-auto flex-1 p-6 pb-2">
            <div className="text-[var(--text-primary)] text-base font-semibold mb-1">Confirm production</div>
            <div className="text-[var(--text-muted2)] text-xs mb-4">This will log today's batch and open the schedule.</div>
            <div className="bg-[var(--bg-input)]/40 rounded-xl p-3 mb-4">
              {totalsForConfirm.map(t => (
                <div key={t.sku_name} className="border-t border-[var(--bg-input)]/30 first:border-0 py-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">{t.sku_name}</span>
                    <span className="text-[var(--text-primary)] font-semibold">{t.qty} pcs</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[var(--text-muted2)] text-xs">+ spare</span>
                    <input type="number" min="0" value={spareQtys[t.sku_name] ?? ''}
                      onChange={e => setSpareQtys(q => ({ ...q, [t.sku_name]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                      placeholder="0"
                      className="w-16 bg-[var(--bg-input)] text-[var(--text-gold)] font-semibold rounded-lg px-2 py-1 text-sm outline-none text-center" />
                    <span className="text-[var(--text-muted2)] text-xs">pcs</span>
                  </div>
                </div>
              ))}
              <div className="text-[var(--text-muted2)] text-xs mt-2 pt-2 border-t border-[var(--bg-input)]/30">for {planDate}</div>
            </div>
            </div>
            {confirmError && <p className="px-6 text-red-400 text-xs">{confirmError}</p>}
            <div className="p-6 pt-3 flex gap-3">
              <button onClick={() => setShowConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-[var(--bg-input)] text-[var(--text-secondary)] text-sm">
                Edit
              </button>
              <button disabled={confirming} onClick={async () => {
                  if (confirming) return
                  setConfirming(true); setConfirmError('')
                  const { data: { user } } = await supabase.auth.getUser()
                  if (!user) { setConfirming(false); setConfirmError('Not connected — try again'); return }
                  const batchRows = totalsForConfirm.filter(t => Number(t.qty) > 0).map(t => ({
                    produced_on: planDate,
                    sku_id: t.sku_id,
                    qty: t.qty,
                    user_id: user.id,
                  }))
                  const spareBatchRows = totalsForConfirm
                    .filter(t => (spareQtys[t.sku_name] || 0) > 0)
                    .map(t => ({
                      produced_on: planDate,
                      sku_id: t.sku_id,
                      qty: spareQtys[t.sku_name],
                      user_id: user.id,
                      is_spare: true,
                    }))
                  if (!(await confirmNoDuplicateBatch(planDate, [...batchRows, ...spareBatchRows]))) { setConfirming(false); return }
                  // normal + spare batches in ONE request: all saved or none
                  const { error } = await supabase.from('production_batches').insert([...batchRows, ...spareBatchRows])
                  setConfirming(false)
                  if (error) { setConfirmError('Production was NOT saved: ' + error.message); return }
                  notifyStockChanged()
                  setSpareQtys({})
                  setShowConfirm(false)
                  window.dispatchEvent(new CustomEvent('prosa:production_confirmed'))
                  window.dispatchEvent(new CustomEvent('prosa:goto', { detail: { tab: 'schedule' } }))
                }}
                className="flex-1 py-2.5 rounded-xl bg-[var(--accent)] disabled:opacity-50 text-white text-sm font-semibold">
                {confirming ? 'Saving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
