import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { X, Clock } from 'lucide-react'

export default function ProspectVisitModal({ planId, stops, onClose, onAdded }) {
  const [prospects, setProspects] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(null)

  useEffect(() => {
    ;(async () => {
      const [{ data: stores }, { data: summary }] = await Promise.all([
        supabase.from('stores')
          .select('id, name, pipeline_status')
          .eq('is_active', true)
          .eq('is_depot', false)
          .in('pipeline_status', ['prospect', 'warm', 'cold'])
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
    const maxOrder = Math.max(0, ...(stops || []).map(s => s.stop_order || 0))
    await supabase.from('plan_stops').insert({
      plan_id: planId,
      store_id: store.id,
      stop_order: maxOrder + 1,
    })
    setAdding(null)
    onAdded()
  }

  const statusLabel = { prospect: 'Prospect', warm: 'Warm', cold: 'Cold' }
  const statusColor = {
    prospect: 'text-[var(--accent)] bg-[var(--accent)]/10',
    warm: 'text-[var(--text-gold)] bg-[var(--text-gold)]/10',
    cold: 'text-[var(--text-muted2)] bg-[var(--bg-input)]',
  }

  return (
    <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/80 backdrop-blur-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
        <div>
          <span className="text-[var(--text-primary)] font-semibold">Visit Prospects</span>
          <p className="text-[var(--text-muted2)] text-xs mt-0.5">Stores not yet onboarded · sorted by days since last visit</p>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X size={20} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {loading && <p className="text-[var(--text-muted2)] text-sm text-center mt-16">Loading...</p>}
        {!loading && prospects.length === 0 && (
          <p className="text-[var(--text-muted2)] text-sm text-center mt-16">No prospects in the system yet</p>
        )}
        {prospects.map(s => (
          <div key={s.id} className="bg-[var(--bg-card)] rounded-xl p-4 flex items-center gap-3">
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
              </div>
            </div>
            <button
              onClick={() => addVisit(s)}
              disabled={adding === s.id}
              className="shrink-0 bg-[var(--accent)] disabled:opacity-50 text-white text-xs font-semibold rounded-xl px-3 py-2 transition-colors hover:opacity-90">
              {adding === s.id ? '...' : '+ Add'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
