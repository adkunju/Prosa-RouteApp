import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { fetchAll, localISO } from './dbUtils'
import ContactButtons, { useStoreContacts } from './ContactButtons'
import PipelineTag from './PipelineTag'
import { useGeolocation, haversineKm } from './useGeolocation'
import { TrendingUp, TrendingDown, AlertTriangle, Package, Star, ClipboardList } from 'lucide-react'
import { CallLogModal, openFollowups } from './FollowupsCard'

function fmt(n) { return `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }
function pct(n) { if (n === null || n === undefined) return null; const v = Number(n); return `${v > 0 ? '+' : ''}${v.toFixed(1)}%` }

function GrowthBadge({ g }) {
  if (g === null || g === undefined) return <span className="text-[var(--text-muted2)] text-xs">No prev data</span>
  const v = Number(g)
  if (v >= 10) return <span className="flex items-center gap-0.5 text-emerald-400 text-xs font-medium"><TrendingUp size={11} />{pct(g)}</span>
  if (v <= -20) return <span className="flex items-center gap-0.5 text-red-400 text-xs font-medium"><TrendingDown size={11} />{pct(g)}</span>
  return <span className="text-[var(--text-muted2)] text-xs">{pct(g)}</span>
}

function fmtShort(ymd) {
  if (!ymd) return ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Latest call on its own full-width line so the remark isn't cut off; tap opens the log
function LastCall({ c, onOpen }) {
  const due = c.follow_up_on && c.follow_up_on <= localISO()
  return (
    <button onClick={onOpen} className="w-full text-left pt-1.5 border-t border-white/5 flex items-start gap-2">
      <span className="text-[11px] shrink-0 mt-px">{c.kind === 'reminder' ? '📌' : c.kind === 'visit' ? '🚚' : '📞'}</span>
      <span className="flex-1 min-w-0">
        <span className="text-[var(--text-muted)] text-xs">{fmtShort(localISO(new Date(c.called_at)))}</span>
        {c.note && <span className="text-[var(--text-secondary)] text-xs whitespace-pre-wrap break-words"> · {c.note}</span>}
        {c.follow_up_on && (
          <span className={`block text-[11px] font-medium mt-0.5 ${due ? 'text-[var(--text-gold)]' : 'text-[var(--text-muted)]'}`}>
            {due ? '⏰ Follow up ' : 'Follow up '}{fmtShort(c.follow_up_on)}
          </span>
        )}
      </span>
    </button>
  )
}

function StoreCard({ s, phones, onChanged, position, lastCall, onOpenLog }) {
  const dormant = s.days_since_visit > 14
  const highReturns = Number(s.return_pct) > 20
  const bigDrop = s.growth_pct !== null && Number(s.growth_pct) <= -30 && s.visit_count >= 5
  const needsAttention = dormant || highReturns || bigDrop
  const distance = position && s._coords ? haversineKm(position.lat, position.lng, s._coords.lat, s._coords.lng).toFixed(1) : null
  const hasReturns = s.return_pct !== null && Number(s.return_pct) > 0
  const hasWaste = s.waste_value > 0
  return (
    <div className={`bg-[var(--bg-card)]/60 backdrop-blur-xl border rounded-2xl overflow-hidden shrink-0 ${needsAttention ? 'border-[var(--text-gold)]/40' : 'border-[var(--bg-input)]/40'}`}>
      {needsAttention && <div className="h-0.5 bg-gradient-to-r from-[var(--text-gold)]/80 to-transparent" />}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</span>
              {s.is_pickup && <span className="text-[var(--text-muted2)] text-[10px] shrink-0">pickup</span>}
              <PipelineTag storeId={s.store_id}
                status={s.pipeline_status || 'prospect'}
                updatedBy={s.pipeline_updated_by} size="xs"
                onChanged={onChanged} />
            </div>
            <div className="text-[var(--text-muted2)] text-xs mt-0.5 flex items-center gap-1.5 flex-wrap">
              {distance !== null && (
                <>
                  <span>{distance} km</span>
                  <a href={`https://www.google.com/maps/search/?api=1&query=${s._coords.lat},${s._coords.lng}`}
                    target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-[var(--accent)]">📍</a>
                  <span className="opacity-50">·</span>
                </>
              )}
              <span className={dormant ? 'text-[var(--text-gold)]' : ''}>
                {s.last_visit ? `${s.days_since_visit}d ago` : 'never delivered'}
              </span>
              <span className="opacity-50">·</span>
              <span>{s.visit_count} visits</span>
            </div>
          </div>
          <span className="flex items-center gap-2 shrink-0">
            <ContactButtons phone={phones[s.store_id]} variant="pill" storeId={s.store_id} storeName={s.name} />
            <button onClick={e => { e.stopPropagation(); onOpenLog() }} title="Call log" aria-label="Call log"
              className="h-9 px-3 rounded-full bg-[var(--bg-input)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/15 hover:text-[var(--accent)] flex items-center gap-1.5 text-xs font-medium transition-colors">
              <ClipboardList size={16} /> Log
            </button>
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <span className="text-[var(--text-primary)] text-2xl font-bold tracking-tight leading-none">{fmt(s.revenue_30d)}</span>
            <span className="text-[var(--text-muted2)] text-[10px] uppercase tracking-wider">30d</span>
            {Number(s.revenue) > Number(s.revenue_30d) && (
              <span className="text-[var(--text-muted2)] text-[10px]">· {fmt(s.revenue)} total</span>
            )}
          </div>
          <GrowthBadge g={s.growth_pct} />
        </div>
        {lastCall && <LastCall c={lastCall} onOpen={onOpenLog} />}

        {(hasReturns || hasWaste) && (
          <div className="flex items-center gap-3 text-xs pt-1.5 border-t border-white/5 flex-wrap">
            {hasReturns && (
              <span className={highReturns ? 'text-red-400 font-medium' : 'text-[var(--text-muted2)]'}>
                {highReturns && '⚠ '}{s.return_pct}% returns
              </span>
            )}
            {hasWaste && (
              <span className="text-[var(--text-muted2)]">₹{Number(s.waste_value).toLocaleString('en-IN')} waste</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const PIPELINE_OPTS = ['all','prospect','onboard','warm','cold','dormant','dropped']


// Token-based fuzzy match: each space-separated token must appear in name
function _tokenMatch(q, name) {
  const t = (q || '').trim().toLowerCase()
  if (!t) return true
  const n = (name || '').toLowerCase()
  return t.split(/\s+/).filter(Boolean).every(x => n.includes(x))
}

export default function SalesScreen() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [pipeline, setPipeline] = useState('all')
  const [searchQ, setSearchQ] = useState('')
  const [showSalesPopup, setShowSalesPopup] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const { position } = useGeolocation()
  const [sortBy, setSortBy] = useState('distance')
  const [showExpiryPopup, setShowExpiryPopup] = useState(false)
  const phones = useStoreContacts()
  const [lastCalls, setLastCalls] = useState({}) // store_id -> latest call log
  const [logStore, setLogStore] = useState(null)

  // Latest call per store; refresh when a call is logged from the follow-up prompt
  useEffect(() => {
    const load = async () => {
      const { data: logs } = await supabase.from('call_logs')
        .select('store_id, kind, note, follow_up_on, called_at').not('store_id', 'is', null)
        .order('called_at', { ascending: false }).limit(2000)
      // Latest entry for the text; earliest OPEN follow-up for the date
      const nextDue = {}
      openFollowups(logs || []).forEach(l => {
        if (!nextDue[l.store_id] || l.follow_up_on < nextDue[l.store_id]) nextDue[l.store_id] = l.follow_up_on
      })
      const map = {}
      ;(logs || []).forEach(l => { if (!map[l.store_id]) map[l.store_id] = { ...l, follow_up_on: nextDue[l.store_id] || null } })
      setLastCalls(map)
    }
    load()
    const bump = () => setReloadKey(k => k + 1)
    window.addEventListener('prosa:call_logged', load)
    window.addEventListener('prosa:pipeline_changed', bump)
    return () => { window.removeEventListener('prosa:call_logged', load); window.removeEventListener('prosa:pipeline_changed', bump) }
  }, [])

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

  const filtered = data
    .filter(s => pipeline === 'all' || s.pipeline_status === pipeline)
    .filter(s => _tokenMatch(searchQ, s.name))
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

  const thisMonth = localISO().slice(0, 7)
  const totalRevenue = data.reduce((n, s) => n + Number(s.revenue), 0)
  const monthRevenue = data.reduce((n, s) => n + Number(s.revenue_30d), 0)
  const totalWaste = data.reduce((n, s) => n + Number(s.waste_value), 0)
  const wasteRate = totalRevenue > 0 ? (totalWaste / (totalRevenue + totalWaste) * 100).toFixed(1) : 0

  if (loading) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted2)]">Loading...</div>

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {logStore && <CallLogModal store={logStore} onClose={() => setLogStore(null)} />}
      <div className="px-4 pt-4 pb-2 shrink-0">
        <div className="grid grid-cols-3 gap-2 mb-3">
          <button onClick={() => setShowSalesPopup(true)}
            className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-xl px-3 py-2 text-left hover:border-[var(--accent)]/40 transition-colors">
            <div className="text-[var(--text-muted2)] text-[9px] uppercase tracking-wider">Month sales</div>
            <div className="text-[var(--text-primary)] text-sm font-bold leading-tight mt-0.5">{fmt(monthRevenue)}</div>
          </button>
          <button onClick={() => setShowExpiryPopup(true)}
            className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-xl px-3 py-2 text-left hover:border-[var(--accent)]/40 transition-colors">
            <div className="text-[var(--text-muted2)] text-[9px] uppercase tracking-wider">Waste rate</div>
            <div className={`text-sm font-bold leading-tight mt-0.5 ${Number(wasteRate) > 15 ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>{wasteRate}%</div>
          </button>
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-xl px-3 py-2">
            <div className="text-[var(--text-muted2)] text-[9px] uppercase tracking-wider">Attention</div>
            <div className={`text-sm font-bold leading-tight mt-0.5 ${attention.length > 0 ? 'text-[var(--text-gold)]' : 'text-[var(--text-primary)]'}`}>{attention.length}</div>
          </div>
        </div>

        <div className="relative mb-2">
          <input
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="Search stores..."
            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] pr-8"
          />
          {searchQ && (
            <button onClick={() => setSearchQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]">✕</button>
          )}
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
        {rows.map(s => <StoreCard key={s.store_id} s={s} phones={phones} onChanged={() => setReloadKey(k => k + 1)} position={position} lastCall={lastCalls[s.store_id]} onOpenLog={() => setLogStore({ store_id: s.store_id, name: s.name })} />)}
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
  const [month, setMonth] = useState(localISO().slice(0, 7))
  const [monthly, setMonthly] = useState([])
  const [storeMonth, setStoreMonth] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { (async () => {
    setLoading(true)
    // Sold = delivered − returned (returns counted against the delivery they came from),
    // same rule as the store totals on the Sales screen.
    const [data, rets] = await Promise.all([
      fetchAll(() => supabase.from("delivery_lines")
        .select("id, store_id, delivered_on, qty_delivered, unit_price, skus(name, unit_price)")
        .not("qty_delivered", "is", null).order("id")),
      fetchAll(() => supabase.from("returns").select("delivery_line_id, qty_returned").not("delivery_line_id", "is", null).order("id")),
    ])
    const retByLine = {}
    rets.forEach(r => { retByLine[r.delivery_line_id] = (retByLine[r.delivery_line_id] || 0) + (r.qty_returned || 0) })
    const lines = data.map(l => ({
      ...l,
      sold: l.qty_delivered - (retByLine[l.id] || 0),
      price: Number(l.unit_price ?? l.skus?.unit_price ?? 0), // ?? so a genuine ₹0 price isn't replaced
    }))
    const byMonth = {}
    lines.forEach(l => {
      const m = (l.delivered_on || "").slice(0, 7)
      if (!m) return
      if (!byMonth[m]) byMonth[m] = { month: m, qty: 0, revenue: 0 }
      byMonth[m].qty += l.sold
      byMonth[m].revenue += l.sold * l.price
    })
    setMonthly(Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)))
    const byStore = {}
    lines.filter(l => (l.delivered_on || "").startsWith(month)).forEach(l => {
      const sid = l.store_id
      const name = stores.find(s => s.store_id === sid)?.name || "Unknown"
      if (!byStore[sid]) byStore[sid] = { name, qty: 0, revenue: 0 }
      byStore[sid].qty += l.sold
      byStore[sid].revenue += l.sold * l.price
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
  const [month, setMonth] = useState(localISO().slice(0, 7))
  const [monthly, setMonthly] = useState([])
  const [storeMonth, setStoreMonth] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { (async () => {
    setLoading(true)
    const data = await fetchAll(() => supabase
      .from("returns")
      .select("store_id, returned_on, qty_returned, skus(unit_price), delivery_lines(unit_price, skus(unit_price, name))")
      .order("id"))
    const lines = data.map(r => ({
      ...r,
      // price of the delivery it came from; unlinked returns fall back to the product price
      price: Number(r.delivery_lines?.unit_price ?? r.delivery_lines?.skus?.unit_price ?? r.skus?.unit_price ?? 0),
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
