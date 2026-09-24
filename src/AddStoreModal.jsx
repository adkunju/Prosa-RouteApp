import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { syncMatrix } from './matrixUtils'

import { X, Search, Loader2, Truck, Clock } from 'lucide-react'

const PLACES_KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY
const ANGAMALY = { lat: 10.1960, lng: 76.3860 }
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export default function AddStoreModal({ onClose, onSaved }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(false)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [placeId, setPlaceId] = useState(null)
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [phone, setPhone] = useState('')
  const [serviceMinutes, setServiceMinutes] = useState(15)
  const [isPickup, setIsPickup] = useState(false)
  const [inForecast, setInForecast] = useState(true)
  const [hours, setHours] = useState(Object.fromEntries(DAYS.map(d => [d, ''])))
  const sessionTokenRef = useRef(crypto.randomUUID())

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 3 || picked) { setSuggestions([]); return }
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
      } catch { setSuggestions([]) }
      setSearching(false)
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery, picked])

  async function selectSuggestion(s) {
    const pid = s.placePrediction.placeId
    setSuggestions([])
    setSearching(true)
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${pid}?fields=displayName,formattedAddress,location,currentOpeningHours,internationalPhoneNumber`,
        { headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': '*' } }
      )
      const place = await res.json()
      setPlaceId(pid)
      setName(place.displayName?.text || searchQuery)
      setAddress(place.formattedAddress || '')
      setLat(place.location?.latitude ?? '')
      setLng(place.location?.longitude ?? '')
      setPhone(place.internationalPhoneNumber || '')
      const descs = place.currentOpeningHours?.weekdayDescriptions
      if (Array.isArray(descs)) {
        const next = { ...hours }
        DAYS.forEach(d => {
          const line = descs.find(x => x.startsWith(d))
          next[d] = line ? line.slice(d.length + 2).trim() : ''
        })
        setHours(next)
      }
      setPicked(true)
      setSearchQuery(place.displayName?.text || '')
    } catch (e) { console.error(e) }
    setSearching(false)
  }

  function startBlank() {
    setPicked(true)
    setName(searchQuery)
    setLat(ANGAMALY.lat)
    setLng(ANGAMALY.lng)
  }

  async function saveStore() {
    if (!name.trim()) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const weekdayDescriptions = DAYS.map(d => `${d}: ${hours[d]?.trim() || 'Unavailable'}`)
    const { data: newStore } = await supabase.from('stores').insert({
      user_id: user.id,
      name: name.trim(),
      address,
      place_id: placeId,
      lat: Number(lat) || null,
      lng: Number(lng) || null,
      contact: phone || '',
      opening_hours: { weekdayDescriptions },
      service_minutes: Number(serviceMinutes) || 15,
      is_pickup: isPickup,
      exclude_from_forecast: !inForecast,
    }).select('id, name').single()

    if (newStore && phone) {
      await supabase.from('store_contacts').insert({
        store_id: newStore.id, title: 'Store Phone', phone,
      })
    }
    // Fill travel times for the new store BEFORE closing (the Dashboard reloads the page on save)
    if (newStore) await syncMatrix().catch(e => console.error('travel matrix sync failed', e))
    setSaving(false)
    onSaved?.(newStore)
    onClose?.()
  }

  const field = "w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"

  return (
    <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/70 backdrop-blur-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--bg-input)]/60 flex items-center justify-between shrink-0">
        <span className="text-[var(--text-primary)] font-semibold">Add store</span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!picked && (
          <>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]" />
              <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search shop name or address..."
                className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
              {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--text-muted2)]" />}
            </div>
            {suggestions.map(s => (
              <button key={s.placePrediction.placeId} onClick={() => selectSuggestion(s)}
                className="w-full text-left bg-[var(--bg-card)]/70 hover:bg-[var(--bg-input)]/60 rounded-xl px-4 py-3 mb-1.5 transition-colors">
                <div className="text-[var(--text-secondary)] text-sm">{s.placePrediction.structuredFormat?.mainText?.text}</div>
                <div className="text-[var(--text-muted2)] text-xs">{s.placePrediction.structuredFormat?.secondaryText?.text}</div>
              </button>
            ))}
            {searchQuery.length >= 3 && (
              <button onClick={startBlank}
                className="w-full text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-xs py-3 transition-colors">
                Not on Google — enter manually
              </button>
            )}
          </>
        )}

        {picked && (
          <>
            <label className="text-[var(--text-muted)] text-xs mb-1 block">Store name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={field + " mb-3"} />

            <label className="text-[var(--text-muted)] text-xs mb-1 block">Address</label>
            <input value={address} onChange={e => setAddress(e.target.value)} className={field + " mb-3"} />

            <label className="text-[var(--text-muted)] text-xs mb-1 block">Coordinates</label>
            <div className="flex gap-2 mb-3">
              <input value={lat} onChange={e => setLat(e.target.value)} placeholder="lat" className={field} />
              <input value={lng} onChange={e => setLng(e.target.value)} placeholder="lng" className={field} />
            </div>

            <label className="text-[var(--text-muted)] text-xs mb-1 block">Phone</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} className={field + " mb-3"} />

            <label className="text-[var(--text-muted)] text-xs mb-1 block">Service time (min)</label>
            <input type="number" min="1" value={serviceMinutes} onChange={e => setServiceMinutes(e.target.value)}
              className="w-24 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-4" />

            <button onClick={() => setIsPickup(v => !v)}
              className="w-full flex items-center justify-between bg-[var(--bg-input)]/40 rounded-xl p-3 mb-2">
              <span className="flex flex-col items-start gap-0.5 text-left">
                <span className="flex items-center gap-2 text-[var(--text-secondary)] text-sm"><Truck size={15} /> Self-pickup</span>
                <span className="text-[var(--text-muted2)] text-xs">Collects from depot — no route stop</span>
              </span>
              <span className={`inline-block shrink-0 w-10 h-5 rounded-full relative transition-colors ${isPickup ? 'bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${isPickup ? 'translate-x-5' : 'translate-x-0'}`} />
              </span>
            </button>

            <button onClick={() => setInForecast(v => !v)}
              className="w-full flex items-center justify-between bg-[var(--bg-input)]/40 rounded-xl p-3 mb-4">
              <span className="flex flex-col items-start gap-0.5 text-left">
                <span className="text-[var(--text-secondary)] text-sm">Include in forecasting</span>
                <span className="text-[var(--text-muted2)] text-xs">Counts toward production &amp; allocation</span>
              </span>
              <span className={`inline-block shrink-0 w-10 h-5 rounded-full relative transition-colors ${inForecast ? 'bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${inForecast ? 'translate-x-5' : 'translate-x-0'}`} />
              </span>
            </button>

            <div className="text-[var(--text-muted)] text-xs mb-2 flex items-center gap-1"><Clock size={12} /> Working hours</div>
            <div className="flex flex-col gap-1.5">
              {DAYS.map(day => (
                <div key={day} className="flex items-center gap-2">
                  <span className="text-[var(--text-muted2)] text-xs w-20 shrink-0">{day.slice(0, 3)}</span>
                  <input value={hours[day]} placeholder="Unavailable"
                    onChange={e => setHours(h => ({ ...h, [day]: e.target.value }))}
                    className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {picked && (
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-[var(--bg-input)]/60 shrink-0 bg-[var(--bg-root)]/80 backdrop-blur-xl flex gap-2">
          <button onClick={() => { setPicked(false); setSuggestions([]) }}
            className="text-[var(--text-muted2)] hover:text-[var(--text-primary)] text-sm px-3">Back</button>
          <button onClick={saveStore} disabled={saving || !name.trim()}
            className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors">
            {saving ? <Loader2 size={16} className="animate-spin" /> : 'Add store'}
          </button>
        </div>
      )}
    </div>
  )
}
