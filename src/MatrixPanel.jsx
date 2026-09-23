import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import { syncMatrix, countMissing } from './matrixUtils'
import { RefreshCw, Route, Loader2, CheckCircle } from 'lucide-react'


export default function MatrixPanel({ onClose }) {
  const [lastComputed, setLastComputed] = useState(null)
  const [cellCount, setCellCount] = useState(0)
  const [storeCount, setStoreCount] = useState(0)
  const [rebuilding, setRebuilding] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(0)

  async function loadStatus() {
    const { data: { user } } = await supabase.auth.getUser()
    const { count } = await supabase
      .from('travel_matrix')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    setCellCount(count || 0)

    const { data: latest } = await supabase
      .from('travel_matrix')
      .select('computed_at')
      .eq('user_id', user.id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setLastComputed(latest?.computed_at || null)

    const { data: stores } = await supabase
      .from('stores')
      .select('id')
      .eq('is_active', true)
      .eq('is_pickup', false)
      .eq('is_d2c', false)
      .not('lat', 'is', null)
    setStoreCount(stores?.length || 0)
    setMissing(await countMissing().catch(() => 0))
  }

  useEffect(() => { loadStatus() }, [])

  async function runSync(full) {
    setRebuilding(true)
    setError('')
    setDone(false)
    try {
      const r = await syncMatrix({ full })
      await loadStatus()
      setDone(r.missing ? `Updated ${r.missing} store${r.missing !== 1 ? 's' : ''}` : 'Already up to date')
      setTimeout(() => setDone(false), 2500)
    } catch (e) {
      setError(e.message || 'Failed to update travel times')
    }
    setRebuilding(false)
  }

  return (
    <div className="absolute top-12 left-3 right-3 bg-[var(--bg-card)]/98 backdrop-blur rounded-xl shadow-2xl border border-[var(--bg-input)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between">
        <span className="text-[var(--text-primary)] text-sm font-medium flex items-center gap-2">
          <Route size={16} className="text-[var(--text-accent)]" /> Travel Matrix
        </span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm">✕</button>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div className="text-sm text-[var(--text-secondary)]">
          {storeCount} routable stores · {cellCount} cached routes
        </div>
        <div className="text-xs text-[var(--text-muted2)]">
          {lastComputed
            ? `Last computed: ${new Date(lastComputed).toLocaleString()}`
            : 'Never computed'}
        </div>
        {error && <div className="text-xs text-red-400 bg-red-900/30 rounded p-2">{error}</div>}
        {missing > 0 && <div className="text-xs text-[var(--text-gold)]">{missing} store{missing !== 1 ? 's have' : ' has'} no travel times yet</div>}
        <button
          onClick={() => runSync(false)}
          disabled={rebuilding}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-medium rounded-lg py-2.5 flex items-center justify-center gap-2 transition-colors"
        >
          {rebuilding ? <><Loader2 size={16} className="animate-spin" /> Computing...</>
            : done ? <><CheckCircle size={16} /> {done}</>
            : <><RefreshCw size={16} /> {missing > 0 ? 'Fill missing stores' : 'Check for missing stores'}</>}
        </button>
        <button onClick={() => runSync(true)} disabled={rebuilding}
          className="text-xs text-[var(--text-muted2)] hover:text-[var(--text-primary)] disabled:opacity-50 self-center">
          Recompute all (after road changes)
        </button>
        <p className="text-xs text-[var(--text-muted2)]">
          New stores get travel times automatically. Filling missing stores uses 2 of your 500 monthly route requests; recompute all uses 1 per ~{Math.max(1, Math.floor(3500 / Math.max(1, storeCount)))} stores.
        </p>
      </div>
    </div>
  )
}
