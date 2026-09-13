import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import { RefreshCw, Route, Loader2, CheckCircle } from 'lucide-react'

const ORS_KEY = import.meta.env.VITE_ORS_KEY
const ORS_URL = 'https://psyfqfyxibrnfoaggfsl.supabase.co/functions/v1/ors-matrix'

export default function MatrixPanel({ onClose }) {
  const [lastComputed, setLastComputed] = useState(null)
  const [cellCount, setCellCount] = useState(0)
  const [storeCount, setStoreCount] = useState(0)
  const [rebuilding, setRebuilding] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

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
  }

  useEffect(() => { loadStatus() }, [])

  async function rebuildMatrix() {
    setRebuilding(true)
    setError('')
    setDone(false)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Get all routable stores (depot + regular, excluding pickup/D2C)
      const { data: stores, error: sErr } = await supabase
        .from('stores')
        .select('id, name, lat, lng')
        .eq('is_active', true)
        .eq('is_pickup', false)
        .eq('is_d2c', false)
        .not('lat', 'is', null)
        .not('lng', 'is', null)

      if (sErr) throw sErr
      if (!stores || stores.length < 2) throw new Error('Need at least 2 stores with coordinates')

      const locations = stores.map(s => [s.lng, s.lat])

      const res = await fetch(ORS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locations,
          metrics: ['distance', 'duration'],
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`ORS API error: ${res.status} — ${errText.slice(0, 200)}`)
      }

      const data = await res.json()
      const { durations, distances } = data

      // Delete old matrix for this user
      await supabase.from('travel_matrix').delete().eq('user_id', user.id)

      // Build rows for every pair (skip self-pairs)
      const rows = []
      for (let i = 0; i < stores.length; i++) {
        for (let j = 0; j < stores.length; j++) {
          if (i === j) continue
          rows.push({
            user_id: user.id,
            from_store_id: stores[i].id,
            to_store_id: stores[j].id,
            seconds: Math.round(durations[i][j]),
            meters: Math.round(distances[i][j]),
          })
        }
      }

      // Insert in chunks of 200 to avoid payload limits
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const { error: insErr } = await supabase.from('travel_matrix').insert(chunk)
        if (insErr) throw insErr
      }

      await loadStatus()
      setDone(true)
      setTimeout(() => setDone(false), 2000)
    } catch (e) {
      setError(e.message || 'Failed to rebuild matrix')
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
        <button
          onClick={rebuildMatrix}
          disabled={rebuilding}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-medium rounded-lg py-2.5 flex items-center justify-center gap-2 transition-colors"
        >
          {rebuilding ? (
            <><Loader2 size={16} className="animate-spin" /> Computing...</>
          ) : done ? (
            <><CheckCircle size={16} /> Done!</>
          ) : (
            <><RefreshCw size={16} /> Rebuild Matrix</>
          )}
        </button>
        <p className="text-xs text-[var(--text-muted2)]">
          Computes drive time & distance between all {storeCount} stores in a single request (1 of your 500 monthly ORS requests).
        </p>
      </div>
    </div>
  )
}
