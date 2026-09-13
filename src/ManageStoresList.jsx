import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { useGeolocation, haversineKm } from './useGeolocation'
import { fuzzyMatch } from './fuzzy'
import StoreDetailModal from './StoreDetailModal'
import { Search, Trash2, Plus, X, Loader2, MapPin, ChevronRight, AlertTriangle } from 'lucide-react'

const PLACES_KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY
const ANGAMALY = { lat: 10.1963, lng: 76.5762 }

export default function ManageStoresList() {
  const [stores, setStores] = useState([])
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [deleting, setDeleting] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [detailStore, setDetailStore] = useState(null)
  const { position, status, retry } = useGeolocation()

  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const [selectedPlace, setSelectedPlace] = useState(null)
  const [serviceMinutes, setServiceMinutes] = useState(15)
  const [saving, setSaving] = useState(false)
  const sessionTokenRef = { current: crypto.randomUUID() }

  async function loadStores() {
    const { data } = await supabase.from('stores').select('*').eq('is_active', true).eq('is_depot', false).order('name')
    setStores(data || [])
  }
  useEffect(() => { loadStores() }, [])

  async function deleteStore(id) {
    setDeleting(id)
    await supabase.from('stores').update({ is_active: false }).eq('id', id)
    await loadStores()
    setDeleting(null)
  }

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 3) { setSuggestions([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY },
          body: JSON.stringify({
            input: searchQuery,
            locationBias: { circle: { center: { latitude: ANGAMALY.lat, longitude: ANGAMALY.lng }, radius: 50000 } },
            sessionToken: sessionTokenRef.current,
          }),
        })
        const data = await res.json()
        setSuggestions(data.suggestions || [])
      } catch (e) { setSuggestions([]) }
      setSearching(false)
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  async function selectSuggestion(s) {
    const placeId = s.placePrediction.placeId
    setSuggestions([])
    setSearching(true)
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${placeId}?fields=displayName,formattedAddress,location,currentOpeningHours,internationalPhoneNumber`,
        { headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': '*' } }
      )
      const place = await res.json()
      setSelectedPlace({ placeId, place })
      setSearchQuery(place.displayName?.text || '')
    } catch (e) { console.error(e) }
    setSearching(false)
  }

  async function saveStore() {
    if (!selectedPlace) return
    setSaving(true)
    const { place, placeId } = selectedPlace
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newStore } = await supabase.from('stores').insert({
      user_id: user.id,
      name: place.displayName?.text || searchQuery,
      address: place.formattedAddress || '',
      place_id: placeId,
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      contact: place.internationalPhoneNumber || '',
      opening_hours: place.currentOpeningHours || null,
      service_minutes: serviceMinutes,
    }).select('id').single()

    if (newStore && place.internationalPhoneNumber) {
      await supabase.from('store_contacts').insert({
        store_id: newStore.id, name: 'Store Phone', phone: place.internationalPhoneNumber,
      })
    }

    await loadStores()
    setShowAdd(false)
    setSearchQuery(''); setSelectedPlace(null); setServiceMinutes(15)
    setSaving(false)
  }

  function openDetail(store) {
    setDetailStore(store)
  }

  const filtered = stores
    .filter(s => fuzzyMatch(query, s.name) || fuzzyMatch(query, s.address || ''))
    .map(s => ({ ...s, distanceKm: position && s.lat ? haversineKm(position.lat, position.lng, s.lat, s.lng) : null }))
    .sort((a, b) => {
      if (sortBy === 'distance') {
        if (a.distanceKm == null) return 1
        if (b.distanceKm == null) return -1
        return a.distanceKm - b.distanceKm
      }
      return a.name.localeCompare(b.name)
    })

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-2.5 text-[var(--text-muted)]" />
          <input type="text" placeholder="Search stores..." value={query} onChange={e => setQuery(e.target.value)}
            className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] text-sm rounded-lg pl-8 pr-3 py-2 outline-none" />
        </div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="bg-[var(--bg-card)] text-[var(--text-secondary)] text-xs rounded-lg px-2 py-2 outline-none">
          <option value="name">Sort: Name</option>
          <option value="distance">Sort: Distance from me</option>
        </select>
      </div>

      {sortBy === 'distance' && (
        <div className="px-4 py-2 bg-[var(--bg-amber-surface)]/20 border-b border-[var(--bg-amber-surface)]/40 text-[var(--text-amber)] text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle size={12} className="shrink-0" />
          {status === 'loading' && 'Getting your location...'}
          {status === 'granted' && 'Location found — note: laptop/desktop location can be off by several km. Phones with GPS are far more accurate.'}
          {status === 'denied' && <>Location denied. <button onClick={retry} className="underline">Retry</button></>}
          {status === 'unavailable' && 'Location not supported on this device.'}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
        {filtered.map(s => (
          <button key={s.id} onClick={() => openDetail(s)}
            className="bg-[var(--bg-card)] rounded-xl p-4 flex items-center justify-between gap-3 text-left hover:bg-[var(--bg-input)]/60 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</div>
              <div className="text-[var(--text-muted2)] text-xs truncate mt-0.5">{s.address}</div>
              {s.distanceKm != null && (
                <div className="text-[var(--text-muted)] text-xs mt-0.5 flex items-center gap-1"><MapPin size={10} /> {s.distanceKm.toFixed(1)} km away</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span onClick={e => { e.stopPropagation(); deleteStore(s.id) }} className="text-[var(--text-faint)] hover:text-red-400 p-1">
                {deleting === s.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              </span>
              <ChevronRight size={15} className="text-[var(--text-faint)]" />
            </div>
          </button>
        ))}
        {filtered.length === 0 && <div className="text-[var(--text-muted2)] text-center mt-16 text-sm">No stores found</div>}
      </div>

      <button onClick={() => setShowAdd(true)}
        className="fixed bottom-24 right-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-full p-4 shadow-xl z-40">
        <Plus size={22} />
      </button>

      {/* Add store modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <div className="bg-[var(--bg-card)]/90 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[var(--text-primary)] font-semibold">Add Store</h2>
              <button onClick={() => setShowAdd(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
            </div>
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-3 text-[var(--text-muted)]" />
              <input type="text" placeholder="Search for a store..." value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSelectedPlace(null) }}
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg pl-9 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" autoFocus />
              {searching && <Loader2 size={16} className="absolute right-3 top-3 text-[var(--text-muted)] animate-spin" />}
            </div>
            {suggestions.length > 0 && (
              <div className="bg-[var(--bg-input)] rounded-lg mb-3 overflow-hidden divide-y divide-slate-600">
                {suggestions.slice(0, 5).map((s, i) => (
                  <button key={i} onClick={() => selectSuggestion(s)} className="w-full text-left px-3 py-2.5 hover:bg-[var(--bg-hover)]">
                    <div className="text-[var(--text-primary)] text-sm">{s.placePrediction.structuredFormat?.mainText?.text}</div>
                    <div className="text-[var(--text-muted)] text-xs mt-0.5">{s.placePrediction.structuredFormat?.secondaryText?.text}</div>
                  </button>
                ))}
              </div>
            )}
            {selectedPlace && (
              <div className="bg-[var(--bg-input)]/60 rounded-lg p-3 mb-3 text-sm">
                <div className="text-[var(--text-primary)] font-medium">{selectedPlace.place.displayName?.text}</div>
                <div className="text-[var(--text-muted)] text-xs mt-0.5">{selectedPlace.place.formattedAddress}</div>
              </div>
            )}
            <div className="flex items-center gap-3 mb-4">
              <label className="text-[var(--text-muted)] text-sm w-36 shrink-0">Service time (min)</label>
              <input type="number" value={serviceMinutes} onChange={e => setServiceMinutes(Number(e.target.value))}
                className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm w-20 outline-none" />
            </div>
            <button onClick={saveStore} disabled={!selectedPlace || saving}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5">
              {saving ? 'Saving...' : 'Save Store'}
            </button>
          </div>
        </div>
      )}

      {detailStore && (
        <StoreDetailModal store={detailStore} onClose={() => setDetailStore(null)} onSaved={loadStores} />
      )}
    </div>
  )
}
