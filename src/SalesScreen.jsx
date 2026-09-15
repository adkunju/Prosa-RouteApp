import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import PipelineTag from './PipelineTag'
import { useGeolocation, haversineKm } from './useGeolocation'
import { TrendingUp, TrendingDown, AlertTriangle, Package, Star } from 'lucide-react'

function fmt(n) { return `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }
function pct(n) { if (n === null || n === undefined) return null; const v = Number(n); return `${v > 0 ? '+' : ''}${v.toFixed(1)}%` }

function GrowthBadge({ g }) {
  if (g === null || g === undefined) return <span className="text-[var(--text-muted2)] text-xs">No prev data</span>
  const v = Number(g)
  if (v >= 10) return <span className="flex items-center gap-0.5 text-emerald-400 text-xs font-medium"><TrendingUp size={11} />{pct(g)}</span>
  if (v <= -20) return <span className="flex items-center gap-0.5 text-red-400 text-xs font-medium"><TrendingDown size={11} />{pct(g)}</span>
  return <span className="text-[var(--text-muted2)] text-xs">{pct(g)}</span>
}

function StoreCard({ s, phones, onChanged }) {
  const dormant = s.days_since_visit > 14
  return (
    <div className={`bg-[var(--bg-card)]/60 backdrop-blur-xl border rounded-2xl p-4 ${dormant ? 'border-[var(--text-gold)]/30' : 'border-[var(--bg-input)]/40'}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</span>
            {s.is_pickup && <span className="text-[var(--text-muted2)] text-[10px] shrink-0">pickup</span>}
            <PipelineTag storeId={s.store_id}
              status={s.pipeline_status || 'prospect'}
              updatedBy={s.pipeline_updated_by} size="xs"
              onChanged={onChanged} />
          </div>
          <div className="text-[var(--text-muted2)] text-xs mt-0.5">
            {s.visit_count} deliveries ·
            {s.last_visit ? ` last ${s.days_since_visit}d ago` : ' never delivered'}
            {position && s._coords ? ` · ${haversineKm(position.lat, position.lng, s._coords.lat, s._coords.lng).toFixed(1)} km 📍` : ''}

          </div>
        </div>
        <ContactButtons phone={phones[s.store_id]} size={13} />
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="bg-[var(--bg-input)]/40 rounded-xl p-2.5">
          <div className="text-[var(--text-muted2)] text-[10px] mb-0.5">Revenue</div>
          <div className="text-[var(--text-primary)] text-sm font-semibold">{fmt(s.revenue)}</div>
        </div>
        <div className="bg-[var(--bg-input)]/40 rounded-xl p-2.5">
          <div className="text-[var(--text-muted2)] text-[10px] mb-0.5">Last 30d</div>
          <div className="text-[var(--text-primary)] text-sm font-semibold">{fmt(s.revenue_30d)}</div>
        </div>
        <div className="bg-[var(--bg-input)]/40 rounded-xl p-2.5">
          <div className="text-[var(--text-muted2)] text-[10px] mb-0.5">Returns</div>
          <div className={`text-sm font-semibold ${Number(s.return_pct) > 20 ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>
            {s.return_pct !== null ? `${s.return_pct}%` : '—'}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <GrowthBadge g={s.growth_pct} />
        {s.waste_value > 0 && (
          <span className="text-[var(--text-muted2)] text-xs">waste {fmt(s.waste_value)}</span>
        )}
      </div>
    </div>
  )
}

const PIPELINE_OPTS = ['all','prospect','onboard','warm','cold','dormant','dropped']

export default function SalesScreen() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [pipeline, setPipeline] = useState('all')
  const [showSalesPopup, setShowSalesPopup] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const { position } = useGeolocation()
  const [sortBy, setSortBy] = useState('distance')
  const [showExpiryPopup, setShowExpiryPopup] = useState(false)
  const phones = useStoreContacts()

  useEffect(() => { (async () => {
    const { data: rows } = await supabase
      .from('store_sales_summary')
      .select('*')
      .eq('user_id', (await supabase.auth.getUser()).data.user.id)
      .order('revenue', { ascending: false })
    // fetch store coords for distance sort
    const { data: coords } = await supabase.from('stores').select('id, lat, lng')
    const coordMap = {}
    ;(coords || []).forEach(s => { coordMap[s.id] = { lat: s.lat, lng: s.lng } })
    setData((rows || []).map(s => ({ ...s, _coords: coordMap[s.store_id] })))
    setLoading(false)
  })() }, [reloadKey])

  const top = data.filter(s => s.visit_count >= 5).slice(0, 10)

  const attention = data.filter(s =>
    (s.visit_count > 0 && s.days_since_visit > 14) ||
    (Number(s.return_pct) > 20 && s.visit_count >= 3) ||
    (s.growth_pct !== null && Number(s.growth_pct) <= -30 && s.visit_count >= 5)
  ).sort((a, b) => {
    const score = s => (s.days_since_visit > 21 ? 3 : 0) + (Number(s.return_pct) > 20 ? 2 : 0) + (Number(s.growth_pct) <= -30 ? 1 : 0)
    return score(b) - score(a)
  })

  const fresh = data.filter(s => s.visit_count === 0 || s.visit_count <= 3)

  const pipelineCounts = data.reduce((acc, s) => {
    const st = s.pipeline_status || 'prospect'
    acc[st] = (acc[st] || 0) + 1
    return acc
  }, {})

  const filtered = pipeline === 'all' ? data : data.filter(s => s.pipeline_status === pipeline)
  const rows = [...filtered].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    if (sortBy === 'last_delivery') return (b.days_since_visit ?? 9999) - (a.days_since_visit ?? 9999)
    if (sortBy === 'distance' && position) {
      const da = a._coords ? haversineKm(position.lat, position.lng, a._coords.lat, a._coords.lng) : 9999
      const db = b._coords ? haversineKm(position.lat, position.lng, b._coords.lat, b._coords.lng) : 9999
      return da - db
    }
    return Number(b.revenue) - Number(a.revenue) // default: revenue
  })

  const thisMonth = new Date().toISOString().slice(0, 7)
  const totalRevenue = data.reduce((n, s) => n + Number(s.revenue), 0)
  const monthRevenue = data.reduce((n, s) => n + Number(s.revenue_30d), 0)
  const totalWaste = data.reduce((n, s) => n + Number(s.waste_value), 0)
  const wasteRate = totalRevenue > 0 ? (totalWaste / (totalRevenue + totalWaste) * 100).toFixed(1) : 0

  if (loading) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted2)]">Loading...</div>

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <div className="grid grid-cols-3 gap-2 mb-4">
          <button onClick={() => setShowSalesPopup(true)}
            className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3 text-left hover:border-[var(--accent)]/40 transition-colors">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Sales this month</div>
            <div className="text-[var(--text-primary)] text-base font-bold">{fmt(monthRevenue)}</div>
          </button>
          <button onClick={() => setShowExpiryPopup(true)}
            className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3 text-left hover:border-[var(--accent)]/40 transition-colors">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Expiry this month</div>
            <div className={`text-base font-bold ${Number(wasteRate) > 15 ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>{wasteRate}%</div>
          </button>
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Attention</div>
            <div className={`text-base font-bold ${attention.length > 0 ? 'text-[var(--text-gold)]' : 'text-[var(--text-primary)]'}`}>{attention.length} stores</div>
          </div>
        </div>

        <div className="flex gap-2">
          <select value={pipeline} onChange={e => setPipeline(e.target.value)}
          className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]">
          <option value="all">All stores ({data.length})</option>
          {PIPELINE_OPTS.filter(o => o !== 'all').map(o => (
            <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}{pipelineCounts[o] ? ` (${pipelineCounts[o]})` : ' (0)'}</option>
          ))}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]">
            <option value="revenue">Revenue</option>
            <option value="name">Name</option>
            <option value="last_delivery">Last delivery</option>
            {position && <option value="distance">Distance</option>}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-28 flex flex-col gap-3">
        {rows.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No stores in this view</p>
          </div>
        )}
        {rows.map(s => <StoreCard key={s.store_id} s={s} phones={phones} onChanged={() => setReloadKey(k => k + 1)} />)}
      </div>
      {showSalesPopup && <SalesPopup onClose={() => setShowSalesPopup(false)} stores={data} />}
      {showExpiryPopup && <ExpiryPopup onClose={() => setShowExpiryPopup(false)} stores={data} />}
    </div>
  )
}


function monthOptions() {
  const opts = []
  const d = new Date()
  for (let i = 0; i < 12; i++) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0')
    opts.push(`${y}-${m}`)
    d.setMonth(d.getMonth() - 1)
  }
  return opts
}

function SalesPopup({ onClose, stores }) {
  const [tab, setTab] = useState('monthly')
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [monthly, setMonthly] = useState([])
  const [storeMonth, setStoreMonth] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { (async () => {
    setLoading(true)
    const { data } = await supabase
      .from("delivery_lines")
      .select("store_id, delivered_on, qty_delivered, unit_price, skus(name, unit_price)")
      .not("qty_delivered", "is", null)
    const lines = (data || []).map(l => ({
      ...l,
      price: Number(l.unit_price || l.skus?.unit_price || 0),
    }))
    const byMonth = {}
    lines.forEach(l => {
      const m = (l.delivered_on || "").slice(0, 7)
      if (!m) return
      if (!byMonth[m]) byMonth[m] = { month: m, qty: 0, revenue: 0 }
      byMonth[m].qty += l.qty_delivered
      byMonth[m].revenue += l.qty_delivered * l.price
    })
    setMonthly(Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)))
    const byStore = {}
    lines.filter(l => (l.delivered_on || "").startsWith(month)).forEach(l => {
      const sid = l.store_id
      const name = stores.find(s => s.store_id === sid)?.name || "Unknown"
      if (!byStore[sid]) byStore[sid] = { name, qty: 0, revenue: 0 }
      byStore[sid].qty += l.qty_delivered
      byStore[sid].revenue += l.qty_delivered * l.price
    })
    setStoreMonth(Object.values(byStore).sort((a, b) => b.revenue - a.revenue))
    setLoading(false)
  })() }, [month])

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="m-4 mt-12 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl flex flex-col max-h-[80vh] shadow-2xl">
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/40 flex items-center justify-between shrink-0">
          <div className="flex gap-2">
            {["monthly","by store"].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={"px-3 py-1 rounded-lg text-xs font-medium transition-colors " + (tab === t ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted2)]")}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {tab === "by store" && (
              <select value={month} onChange={e => setMonth(e.target.value)}
                className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-xs outline-none">
                {monthOptions().map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <button onClick={onClose} className="text-[var(--text-muted)] text-lg">x</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-center text-[var(--text-muted2)] py-8">Loading...</div>}
          {!loading && tab === "monthly" && monthly.map(r => (
            <div key={r.month} className="flex justify-between py-2 border-t border-[var(--bg-input)]/40 text-sm">
              <span className="text-[var(--text-secondary)]">{r.month}</span>
              <span className="text-[var(--text-muted2)] text-xs">{r.qty} pcs</span>
              <span className="text-[var(--text-primary)] font-medium">{fmt(r.revenue)}</span>
            </div>
          ))}
          {!loading && tab === "by store" && storeMonth.map(r => (
            <div key={r.name} className="flex justify-between py-2 border-t border-[var(--bg-input)]/40 text-sm">
              <span className="text-[var(--text-secondary)] truncate flex-1">{r.name}</span>
              <span className="text-[var(--text-muted2)] text-xs ml-2">{r.qty} pcs</span>
              <span className="text-[var(--text-primary)] font-medium ml-2">{fmt(r.revenue)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExpiryPopup({ onClose, stores }) {
  const [tab, setTab] = useState("monthly")
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [monthly, setMonthly] = useState([])
  const [storeMonth, setStoreMonth] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { (async () => {
    setLoading(true)
    const { data } = await supabase
      .from("returns")
      .select("store_id, returned_on, qty_returned, delivery_lines(unit_price, skus(unit_price, name))")
    const lines = (data || []).map(r => ({
      ...r,
      price: Number(r.delivery_lines?.unit_price || r.delivery_lines?.skus?.unit_price || 0),
    }))
    const byMonth = {}
    lines.forEach(l => {
      const m = (l.returned_on || "").slice(0, 7)
      if (!m) return
      if (!byMonth[m]) byMonth[m] = { month: m, qty: 0, value: 0 }
      byMonth[m].qty += l.qty_returned
      byMonth[m].value += l.qty_returned * l.price
    })
    setMonthly(Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)))
    const byStore = {}
    lines.filter(l => (l.returned_on || "").startsWith(month)).forEach(l => {
      const sid = l.store_id
      const name = stores.find(s => s.store_id === sid)?.name || "Unknown"
      if (!byStore[sid]) byStore[sid] = { name, qty: 0, value: 0 }
      byStore[sid].qty += l.qty_returned
      byStore[sid].value += l.qty_returned * l.price
    })
    setStoreMonth(Object.values(byStore).sort((a, b) => b.value - a.value))
    setLoading(false)
  })() }, [month])

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="m-4 mt-12 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-2xl flex flex-col max-h-[80vh] shadow-2xl">
        <div className="px-4 py-3 border-b border-[var(--bg-input)]/40 flex items-center justify-between shrink-0">
          <div className="flex gap-2">
            {["monthly","by store"].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={"px-3 py-1 rounded-lg text-xs font-medium transition-colors " + (tab === t ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted2)]")}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {tab === "by store" && (
              <select value={month} onChange={e => setMonth(e.target.value)}
                className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-xs outline-none">
                {monthOptions().map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <button onClick={onClose} className="text-[var(--text-muted)] text-lg">x</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-center text-[var(--text-muted2)] py-8">Loading...</div>}
          {!loading && tab === "monthly" && monthly.map(r => (
            <div key={r.month} className="flex justify-between py-2 border-t border-[var(--bg-input)]/40 text-sm">
              <span className="text-[var(--text-secondary)]">{r.month}</span>
              <span className="text-[var(--text-muted2)] text-xs">{r.qty} returned</span>
              <span className="text-red-400 font-medium">{fmt(r.value)}</span>
            </div>
          ))}
          {!loading && tab === "by store" && storeMonth.map(r => (
            <div key={r.name} className="flex justify-between py-2 border-t border-[var(--bg-input)]/40 text-sm">
              <span className="text-[var(--text-secondary)] truncate flex-1">{r.name}</span>
              <span className="text-[var(--text-muted2)] text-xs ml-2">{r.qty} returned</span>
              <span className="text-red-400 font-medium ml-2">{fmt(r.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
