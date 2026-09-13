import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from './supabaseClient'

import * as maplibregl2 from 'maplibre-gl'
import { Plus, X, Search, Loader2, MapPin, Building2, Trash2, List } from 'lucide-react'

const ANGAMALY = { lng: 76.5762, lat: 10.1963 }
const PLACES_KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY

export default function StoresScreen() {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef({})

  const [stores, setStores] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [showList, setShowList] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedPlace, setSelectedPlace] = useState(null)
  const [serviceMinutes, setServiceMinutes] = useState(15)
  const [notes, setNotes] = useState('')
  const [deleting, setDeleting] = useState(null)
  const sessionTokenRef = useRef(crypto.randomUUID())

  const loadStores = useCallback(async () => {
    const { data } = await supabase.from('stores').select('*').eq('is_active', true).order('name')
    if (data) setStores(data)
  }, [])

  useEffect(() => {
    if (mapInstanceRef.current) return
    const map = new maplibregl2.Map({
      container: mapRef.current,
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
      center: [ANGAMALY.lng, ANGAMALY.lat],
      zoom: 12,
    })
    map.addControl(new maplibregl2.NavigationControl(), 'top-right')
    mapInstanceRef.current = map
    loadStores()
  }, [loadStores])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    stores.forEach(store => {
      if (!store.lat || !store.lng) return
      if (markersRef.current[store.id]) return
      const el = document.createElement('div')
      el.className = store.is_depot
        ? 'w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow-lg cursor-pointer'
        : 'w-3.5 h-3.5 rounded-full bg-[var(--accent)] border-2 border-white shadow-lg cursor-pointer'
      const marker = new maplibregl2.Marker({ element: el })
        .setLngLat([store.lng, store.lat])
        .setPopup(new maplibregl2.Popup({ offset: 12 }).setHTML(
          `<div class="font-semibold text-sm">${store.name}</div>
           <div class="text-xs text-gray-500 mt-0.5">${store.address || ''}</div>`
        ))
        .addTo(map)
      markersRef.current[store.id] = marker
    })
  }, [stores])

  async function deleteStore(id) {
    setDeleting(id)
    await supabase.from('stores').update({ is_active: false }).eq('id', id)
    // Remove marker from map
    if (markersRef.current[id]) {
      markersRef.current[id].remove()
      delete markersRef.current[id]
    }
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
      sessionTokenRef.current = crypto.randomUUID()
    } catch (e) { console.error(e) }
    setSearching(false)
  }

  async function saveStore() {
    if (!selectedPlace) return
    setSaving(true)
    const { place, placeId } = selectedPlace
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('stores').insert({
      user_id: user.id,
      name: place.displayName?.text || searchQuery,
      address: place.formattedAddress || '',
      place_id: placeId,
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      contact: place.internationalPhoneNumber || '',
      opening_hours: place.currentOpeningHours || null,
      service_minutes: serviceMinutes,
      notes,
    })
    await loadStores()
    resetForm()
    setSaving(false)
  }

  function resetForm() {
    setShowForm(false); setSearchQuery(''); setSuggestions([])
    setSelectedPlace(null); setServiceMinutes(15); setNotes('')
  }

  const activeStores = stores.filter(s => !s.is_depot)

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div ref={mapRef} className="flex-1" />

      {/* Store count badge — click to open list */}
      <button
        onClick={() => setShowList(v => !v)}
        className="absolute top-3 left-3 bg-[var(--bg-card)]/90 text-[var(--text-heading2)] text-xs px-2.5 py-1.5 rounded-full backdrop-blur flex items-center gap-1.5 hover:bg-[var(--bg-input)]/90 transition-colors"
      >
        <MapPin size={12} className="text-[var(--text-accent)]" />
        {activeStores.length} stores
        <List size={12} className="text-[var(--text-muted)]" />
      </button>



      {/* Store list panel */}
      {showList && (
        <div className="absolute top-12 left-3 right-3 bg-[var(--bg-card)]/98 backdrop-blur rounded-xl shadow-2xl border border-[var(--bg-input)] overflow-hidden max-h-72 flex flex-col">
          <div className="px-3 py-2.5 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
            <span className="text-[var(--text-primary)] text-sm font-medium">All Stores</span>
            <button onClick={() => setShowList(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X size={16} />
            </button>
          </div>
          <div className="overflow-y-auto">
            {activeStores.length === 0 && (
              <div className="text-[var(--text-muted2)] text-sm text-center py-6">No stores added yet</div>
            )}
            {activeStores.map(s => (
              <div key={s.id} className="flex items-center justify-between px-3 py-3 border-b border-[var(--bg-input)]/50 last:border-0 hover:bg-[var(--bg-input)]/40 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text-primary)] text-sm font-medium truncate">{s.name}</div>
                  <div className="text-[var(--text-muted2)] text-xs truncate mt-0.5">{s.address}</div>
                </div>
                <button
                  onClick={() => deleteStore(s.id)}
                  disabled={deleting === s.id}
                  className="text-[var(--text-faint)] hover:text-red-400 transition-colors ml-3 shrink-0"
                >
                  {deleting === s.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add store button */}
      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="absolute bottom-4 right-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-full p-4 shadow-xl transition-colors"
        >
          <Plus size={22} />
        </button>
      )}

      {/* Add store panel */}
      {showForm && (
        <div className="absolute bottom-0 left-0 right-0 bg-[var(--bg-card)] border-t border-[var(--bg-input)] rounded-t-2xl p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[var(--text-primary)] font-semibold flex items-center gap-2">
              <Building2 size={18} className="text-[var(--text-accent)]" /> Add Store
            </h2>
            <button onClick={resetForm} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-3 text-[var(--text-muted)]" />
            <input type="text" placeholder="Search for a store or place..."
              value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setSelectedPlace(null) }}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg pl-9 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
              autoFocus />
            {searching && <Loader2 size={16} className="absolute right-3 top-3 text-[var(--text-muted)] animate-spin" />}
          </div>
          {suggestions.length > 0 && (
            <div className="bg-[var(--bg-input)] rounded-lg mb-3 overflow-hidden divide-y divide-slate-600">
              {suggestions.slice(0, 5).map((s, i) => (
                <button key={i} onClick={() => selectSuggestion(s)}
                  className="w-full text-left px-3 py-2.5 hover:bg-[var(--bg-hover)] transition-colors">
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
              {selectedPlace.place.internationalPhoneNumber && (
                <div className="text-[var(--text-muted)] text-xs mt-0.5">{selectedPlace.place.internationalPhoneNumber}</div>
              )}
            </div>
          )}
          <div className="flex items-center gap-3 mb-3">
            <label className="text-[var(--text-muted)] text-sm w-36 shrink-0">Service time (min)</label>
            <input type="number" value={serviceMinutes} onChange={e => setServiceMinutes(Number(e.target.value))}
              className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm w-20 outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>
          <div className="mb-4">
            <input type="text" placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>
          <button onClick={saveStore} disabled={!selectedPlace || saving}
            className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 transition-colors">
            {saving ? 'Saving...' : 'Save Store'}
          </button>
        </div>
      )}
    </div>
  )
}
