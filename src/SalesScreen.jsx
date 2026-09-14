import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import ContactButtons, { useStoreContacts } from './ContactButtons'
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

function StoreCard({ s, phones }) {
  const dormant = s.days_since_visit > 14
  return (
    <div className={`bg-[var(--bg-card)]/60 backdrop-blur-xl border rounded-2xl p-4 ${dormant ? 'border-[var(--text-gold)]/30' : 'border-[var(--bg-input)]/40'}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</span>
            {s.is_pickup && <span className="text-[var(--text-muted2)] text-[10px] shrink-0">pickup</span>}
          </div>
          <div className="text-[var(--text-muted2)] text-xs mt-0.5">
            {s.visit_count} deliveries ·
            {s.last_visit
              ? ` last ${s.days_since_visit}d ago`
              : ' never delivered'}
            {dormant && <span className="text-[var(--text-gold)]"> · dormant</span>}
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

const TABS = ['Top', 'Attention', 'New', 'All']

export default function SalesScreen() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('Top')
  const phones = useStoreContacts()

  useEffect(() => { (async () => {
    const { data: rows } = await supabase
      .from('store_sales_summary')
      .select('*')
      .eq('user_id', (await supabase.auth.getUser()).data.user.id)
      .order('revenue', { ascending: false })
    setData(rows || [])
    setLoading(false)
  })() }, [])

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

  const views = { Top: top, Attention: attention, New: fresh, All: data }
  const rows = views[tab] || []

  const totalRevenue = data.reduce((n, s) => n + Number(s.revenue), 0)
  const totalWaste = data.reduce((n, s) => n + Number(s.waste_value), 0)
  const wasteRate = totalRevenue > 0 ? (totalWaste / (totalRevenue + totalWaste) * 100).toFixed(1) : 0

  if (loading) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted2)]">Loading...</div>

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Total revenue</div>
            <div className="text-[var(--text-primary)] text-base font-bold">{fmt(totalRevenue)}</div>
          </div>
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Waste</div>
            <div className={`text-base font-bold ${Number(wasteRate) > 15 ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>{wasteRate}%</div>
          </div>
          <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-3">
            <div className="text-[var(--text-muted2)] text-[10px] mb-1">Attention</div>
            <div className={`text-base font-bold ${attention.length > 0 ? 'text-[var(--text-gold)]' : 'text-[var(--text-primary)]'}`}>{attention.length} stores</div>
          </div>
        </div>

        <div className="flex gap-1 bg-[var(--bg-input)]/40 rounded-xl p-1">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted2)]'}`}>
              {t}{t === 'Attention' && attention.length > 0 ? ` (${attention.length})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-28 flex flex-col gap-3">
        {rows.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Package size={40} className="mx-auto mb-3 opacity-40" />
            <p>No stores in this view</p>
          </div>
        )}
        {rows.map(s => <StoreCard key={s.store_id} s={s} phones={phones} />)}
      </div>
    </div>
  )
}
