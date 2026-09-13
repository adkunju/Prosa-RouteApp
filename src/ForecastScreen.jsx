import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { TrendingUp, AlertTriangle, Clock } from 'lucide-react'

function daysUntil(dateStr) {
  const diff = Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
  return diff
}

function DueBadge({ dateStr }) {
  const days = daysUntil(dateStr)
  if (days < 0) return <span className="text-xs bg-red-900/60 text-red-300 px-2 py-0.5 rounded-full whitespace-nowrap">{Math.abs(days)}d overdue</span>
  if (days === 0) return <span className="text-xs bg-[var(--bg-orange-surface)]/60 text-[var(--text-amber2)] px-2 py-0.5 rounded-full whitespace-nowrap">Due today</span>
  if (days <= 2) return <span className="text-xs bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded-full whitespace-nowrap">Due in {days}d</span>
  return <span className="text-xs bg-[var(--bg-input)] text-[var(--text-secondary)] px-2 py-0.5 rounded-full whitespace-nowrap">Due in {days}d</span>
}

export default function ForecastScreen() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState('due')

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('store_sku_forecast')
      .select('*')
    setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'due') return new Date(a.next_visit_due) - new Date(b.next_visit_due)
    if (sortBy === 'rate') return b.avg_daily_rate - a.avg_daily_rate
    if (sortBy === 'visits') return b.visit_count - a.visit_count
    return 0
  })

  const overdueCount = rows.filter(r => daysUntil(r.next_visit_due) < 0).length
  const lowConfidenceCount = rows.filter(r => r.confidence === 'low').length

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
        <span className="text-[var(--text-muted)] text-sm flex items-center gap-1.5">
          <TrendingUp size={14} className="text-[var(--text-accent)]" />
          {rows.length} store-product forecasts
        </span>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="bg-[var(--bg-card)] text-[var(--text-secondary)] text-xs rounded-lg px-2 py-1.5 outline-none"
        >
          <option value="due">Sort: Due date</option>
          <option value="rate">Sort: Sales rate</option>
          <option value="visits">Sort: Visit count</option>
        </select>
      </div>

      {(overdueCount > 0 || lowConfidenceCount > 0) && (
        <div className="px-4 py-2 bg-[var(--bg-amber-surface)]/20 border-b border-[var(--bg-amber-surface)]/40 flex items-center gap-2 text-xs text-[var(--text-amber)] shrink-0">
          <AlertTriangle size={13} />
          {overdueCount > 0 && `${overdueCount} overdue`}
          {overdueCount > 0 && lowConfidenceCount > 0 && ' · '}
          {lowConfidenceCount > 0 && `${lowConfidenceCount} low confidence (<8 visits)`}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {loading && <div className="text-[var(--text-muted2)] text-center mt-16">Loading forecast...</div>}
        {!loading && sorted.length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <Clock size={40} className="mx-auto mb-3 opacity-40" />
            <p>No forecast data yet</p>
            <p className="text-sm mt-1">Log a few delivery visits to see forecasts</p>
          </div>
        )}
        {sorted.map(row => (
          <div key={`${row.store_id}-${row.sku_id}`} className="bg-[var(--bg-card)] rounded-xl p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="min-w-0 flex-1">
                <div className="text-[var(--text-primary)] text-sm font-medium truncate">{row.store_name}</div>
                <div className="text-[var(--text-muted)] text-xs mt-0.5">{row.sku_name}</div>
              </div>
              <DueBadge dateStr={row.next_visit_due} />
            </div>
            <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] mt-2">
              <span>{row.avg_daily_rate}/day ± {row.rate_stddev}</span>
              <span className="text-[var(--text-faint)]">·</span>
              <span>{row.visit_count} visits</span>
              {row.confidence === 'low' && (
                <>
                  <span className="text-[var(--text-faint)]">·</span>
                  <span className="text-[var(--text-gold)]">low confidence</span>
                </>
              )}
              {row.has_stockout_gap && (
                <>
                  <span className="text-[var(--text-faint)]">·</span>
                  <span className="text-[var(--text-amber)]">possible stockouts</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
