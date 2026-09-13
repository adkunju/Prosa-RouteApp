import { useState } from 'react'
import { supabase } from './supabaseClient'
import { RefreshCw, Loader2, CheckCircle } from 'lucide-react'

const PLACES_KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

export default function BulkSyncPanel({ onClose }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })
  const [results, setResults] = useState([])
  const [done, setDone] = useState(false)

  async function syncStore(store, contactsByStore) {
    try {
      let place, placeId
      if (store.place_id) {
        const res = await fetch(
          `https://places.googleapis.com/v1/places/${store.place_id}?fields=displayName,formattedAddress,currentOpeningHours,internationalPhoneNumber`,
          { headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': '*' } }
        )
        place = await res.json()
        placeId = store.place_id
        if (place.error) throw new Error('stale place_id')
      } else {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': PLACES_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.currentOpeningHours,places.internationalPhoneNumber',
          },
          body: JSON.stringify({ textQuery: `${store.name} ${store.address || ''}` }),
        })
        const data = await res.json()
        if (!data.places || data.places.length === 0) return { name: store.name, status: 'no match' }
        place = data.places[0]
        placeId = place.id
      }

      const updates = { place_id: placeId }
      if (place.currentOpeningHours) updates.opening_hours = place.currentOpeningHours
      await supabase.from('stores').update(updates).eq('id', store.id)

      if (place.internationalPhoneNumber) {
        const existing = contactsByStore[store.id] || []
        const already = existing.some(c => c.phone.replace(/\D/g, '') === place.internationalPhoneNumber.replace(/\D/g, ''))
        if (!already) {
          await supabase.from('store_contacts').insert({ store_id: store.id, name: 'Store Phone', phone: place.internationalPhoneNumber })
        }
      }
      return { name: store.name, status: place.currentOpeningHours ? 'synced' : 'synced (no hours listed)' }
    } catch (e) {
      return { name: store.name, status: 'failed' }
    }
  }

  async function runBulkSync() {
    setRunning(true)
    setResults([])
    setDone(false)

    const { data: stores } = await supabase.from('stores').select('id, name, address, place_id')
      .eq('is_active', true).eq('is_depot', false)
    const { data: allContacts } = await supabase.from('store_contacts').select('store_id, phone')
    const contactsByStore = {}
    ;(allContacts || []).forEach(c => {
      if (!contactsByStore[c.store_id]) contactsByStore[c.store_id] = []
      contactsByStore[c.store_id].push(c)
    })

    const list = stores || []
    setProgress({ done: 0, total: list.length, current: '' })
    const out = []
    for (let i = 0; i < list.length; i++) {
      setProgress({ done: i, total: list.length, current: list[i].name })
      const result = await syncStore(list[i], contactsByStore)
      out.push(result)
      await sleep(250) // be polite to the API
    }
    setResults(out)
    setProgress(p => ({ ...p, done: list.length }))
    setRunning(false)
    setDone(true)
  }

  return (
    <div className="absolute top-12 left-3 right-3 bg-[var(--bg-card)]/98 backdrop-blur rounded-xl shadow-2xl border border-[var(--bg-input)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between">
        <span className="text-[var(--text-primary)] text-sm font-medium flex items-center gap-2">
          <RefreshCw size={16} className="text-[var(--text-accent)]" /> Sync All Stores from Google
        </span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm">✕</button>
      </div>
      <div className="p-4 flex flex-col gap-3 max-h-96 overflow-y-auto">
        <p className="text-xs text-[var(--text-muted2)]">
          Looks up every store on Google, pulls working hours, and adds a "Store Phone" contact if a number is found. Safe to re-run anytime.
        </p>
        {running && (
          <div className="text-xs text-[var(--text-muted)]">
            Syncing {progress.done + 1} of {progress.total}: {progress.current}
          </div>
        )}
        {results.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            {results.map((r, i) => (
              <div key={i} className="flex justify-between">
                <span className="text-[var(--text-secondary)] truncate">{r.name}</span>
                <span className={r.status.includes('synced') ? 'text-[var(--accent)]' : 'text-[var(--text-gold)]'}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
        <button onClick={runBulkSync} disabled={running}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-medium rounded-lg py-2.5 flex items-center justify-center gap-2 transition-colors">
          {running ? <Loader2 size={16} className="animate-spin" /> : done ? <CheckCircle size={16} /> : <RefreshCw size={16} />}
          {running ? 'Syncing...' : done ? 'Sync again' : 'Start Sync'}
        </button>
      </div>
    </div>
  )
}
