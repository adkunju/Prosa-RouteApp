import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { useGeolocation, haversineKm } from './useGeolocation'
import { X, Search, Loader2, Phone, MessageCircle, Trash2, Plus, Clock, MapPin, RefreshCw, Truck } from 'lucide-react'

const PLACES_KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY
const ANGAMALY = { lat: 10.1963, lng: 76.5762 }
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function extractHours(descs, dayName) {
  if (!Array.isArray(descs)) return null
  const line = descs.find(d => d.startsWith(dayName))
  if (!line) return null
  return line.slice(dayName.length + 1).trim()
}

export default function StoreDetailModal({ store, onClose, onSaved }) {
  const { position } = useGeolocation()
  const [editLat, setEditLat] = useState(store.lat ?? '')
  const [editLng, setEditLng] = useState(store.lng ?? '')
  const [serviceMinutes, setServiceMinutes] = useState(store.service_minutes ?? 15)
  const [isPickup, setIsPickup] = useState(!!store.is_pickup)
  const [inForecast, setInForecast] = useState(!store.exclude_from_forecast)
  const [hours, setHours] = useState(() => {
    const descs = store.opening_hours?.weekdayDescriptions
    const obj = {}
    DAYS.forEach(d => { obj[d] = extractHours(descs, d) ?? '' })
    return obj
  })
  const [contacts, setContacts] = useState([])
  const [newContactName, setNewContactName] = useState('')
  const [newContactPhone, setNewContactPhone] = useState('')
  const [savingDetail, setSavingDetail] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  const [relocateQuery, setRelocateQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const [selectedPlace, setSelectedPlace] = useState(null)
  const sessionTokenRef = { current: crypto.randomUUID() }

  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  const [callTarget, setCallTarget] = useState(null)
  const [callNote, setCallNote] = useState('')
  const [savingCall, setSavingCall] = useState(false)

  async function loadContacts() {
    const { data } = await supabase.from('store_contacts').select('*').eq('store_id', store.id).order('created_at')
    setContacts(data || [])
  }
  useEffect(() => { loadContacts() }, [])

  useEffect(() => {
    if (!relocateQuery || relocateQuery.length < 3) { setSuggestions([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY },
          body: JSON.stringify({
            input: relocateQuery,
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
  }, [relocateQuery])

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
      setRelocateQuery(place.displayName?.text || '')
    } catch (e) { console.error(e) }
    setSearching(false)
  }

  async function syncFromGoogle() {
    setSyncing(true)
    setSyncMessage('')
    try {
      let place, placeId
      if (store.place_id) {
        const res = await fetch(
          `https://places.googleapis.com/v1/places/${store.place_id}?fields=displayName,formattedAddress,location,currentOpeningHours,internationalPhoneNumber`,
          { headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': '*' } }
        )
        place = await res.json()
        placeId = store.place_id
        if (place.error) throw new Error('Saved place ID not found')
      } else {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': PLACES_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.currentOpeningHours,places.internationalPhoneNumber,places.location',
          },
          body: JSON.stringify({ textQuery: `${store.name} ${store.address || ''}` }),
        })
        const data = await res.json()
        if (!data.places || data.places.length === 0) throw new Error('No match found on Google')
        place = data.places[0]
        placeId = place.id
      }

      const descs = place.currentOpeningHours?.weekdayDescriptions
      if (Array.isArray(descs)) {
        const newHours = {}
        DAYS.forEach(d => { newHours[d] = extractHours(descs, d) ?? '' })
        setHours(newHours)
      }

      await supabase.from('stores').update({
        place_id: placeId,
        opening_hours: place.currentOpeningHours || null,
      }).eq('id', store.id)

      if (place.internationalPhoneNumber) {
        const already = contacts.some(c => c.phone.replace(/\D/g, '') === place.internationalPhoneNumber.replace(/\D/g, ''))
        if (!already) {
          await supabase.from('store_contacts').insert({
            store_id: store.id, name: 'Store Phone', phone: place.internationalPhoneNumber,
          })
          await loadContacts()
        }
      }

      setSyncMessage(Array.isArray(descs) ? 'Hours & contact synced from Google' : 'Synced — no hours listed on Google for this place')
    } catch (e) {
      setSyncMessage(e.message || 'Could not sync from Google')
    }
    setSyncing(false)
  }

  async function saveAll() {
    setSavingDetail(true)
    const weekdayDescriptions = DAYS.map(d => `${d}: ${hours[d]?.trim() || 'Unavailable'}`)
    const updates = {
      lat: editLat !== '' ? Number(editLat) : store.lat,
      lng: editLng !== '' ? Number(editLng) : store.lng,
      service_minutes: Number(serviceMinutes),
      opening_hours: { weekdayDescriptions },
      is_pickup: isPickup,
      exclude_from_forecast: !inForecast,
    }
    if (selectedPlace) {
      updates.address = selectedPlace.place.formattedAddress || store.address
      updates.place_id = selectedPlace.placeId
      updates.lat = selectedPlace.place.location?.latitude ?? updates.lat
      updates.lng = selectedPlace.place.location?.longitude ?? updates.lng
    }
    await supabase.from('stores').update(updates).eq('id', store.id)
    setSavingDetail(false)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
    onSaved?.()
  }

  async function addContact() {
    if (!newContactPhone.trim()) return
    await supabase.from('store_contacts').insert({ store_id: store.id, name: newContactName.trim() || null, phone: newContactPhone.trim() })
    setNewContactName(''); setNewContactPhone('')
    await loadContacts()
  }

  async function deleteContact(id) {
    await supabase.from('store_contacts').delete().eq('id', id)
    await loadContacts()
  }

  function openWhatsapp(phone) {
    const clean = phone.replace(/[^\d+]/g, '')
    window.open(`https://wa.me/${clean.replace('+', '')}`, '_blank')
  }

  function startCall(contact) {
    window.location.href = `tel:${contact.phone}`
    setCallTarget(contact)
    setCallNote('')
  }

  async function confirmCallLog(didCall) {
    if (didCall) {
      setSavingCall(true)
      await supabase.from('call_logs').insert({ store_contact_id: callTarget.id, note: callNote.trim() || null })
      setSavingCall(false)
    }
    setCallTarget(null)
  }

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-root)]/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-[var(--bg-card)]/90 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[var(--text-primary)] font-semibold">{store.name}</h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
        </div>
        <div className="text-[var(--text-muted)] text-xs mb-3">{store.address}</div>

{/* Coordinates */}
        <div className="bg-[var(--bg-input)]/40 rounded-xl p-3 mb-4">
          <div className="text-[var(--text-muted)] text-xs mb-2">Coordinates</div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" step="0.000001" value={editLat} onChange={e => setEditLat(e.target.value)}
              placeholder="Latitude"
              className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            <input type="number" step="0.000001" value={editLng} onChange={e => setEditLng(e.target.value)}
              placeholder="Longitude"
              className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>
        </div>

        {/* Re-search location */}
        <div className="mb-4">
          <div className="text-[var(--text-muted)] text-xs mb-2">Or search to relocate</div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-[var(--text-muted)]" />
            <input type="text" placeholder="Search for correct location..." value={relocateQuery}
              onChange={e => { setRelocateQuery(e.target.value); setSelectedPlace(null) }}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            {searching && <Loader2 size={14} className="absolute right-3 top-2.5 text-[var(--text-muted)] animate-spin" />}
          </div>
          {suggestions.length > 0 && (
            <div className="bg-[var(--bg-input)] rounded-lg mt-2 overflow-hidden divide-y divide-slate-600">
              {suggestions.slice(0, 4).map((s, i) => (
                <button key={i} onClick={() => selectSuggestion(s)} className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)]">
                  <div className="text-[var(--text-primary)] text-xs font-medium">{s.placePrediction.structuredFormat?.mainText?.text}</div>
                  <div className="text-[var(--text-muted)] text-[11px] mt-0.5">{s.placePrediction.structuredFormat?.secondaryText?.text}</div>
                </button>
              ))}
            </div>
          )}
          {selectedPlace && (
            <div className="bg-[var(--bg-success-surface)]/30 rounded-lg p-3 mt-2 text-[var(--text-accent)] text-xs">
              <div className="font-medium text-emerald-200 mb-1">{selectedPlace.place.displayName?.text}</div>
              <div>{selectedPlace.place.formattedAddress}</div>
              {selectedPlace.place.internationalPhoneNumber && (
                <div className="mt-1 text-[var(--accent)]/80">{selectedPlace.place.internationalPhoneNumber}</div>
              )}
              {position && selectedPlace.place.location && (
                <div className="mt-1.5 flex items-center gap-1 text-[var(--accent)]/80">
                  <MapPin size={11} />
                  {haversineKm(position.lat, position.lng, selectedPlace.place.location.latitude, selectedPlace.place.location.longitude).toFixed(1)} km from your current location
                </div>
              )}
            </div>
          )}
        </div>

        {/* Service time */}
        <div className="flex items-center gap-3 mb-4">
          <label className="text-[var(--text-muted)] text-xs w-28 shrink-0">Service time (min)</label>
          <input type="number" value={serviceMinutes} onChange={e => setServiceMinutes(e.target.value)}
            className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm w-20 outline-none focus:ring-2 focus:ring-[var(--accent)]" />
        </div>

        {/* Self-pickup toggle */}
        <button onClick={() => setIsPickup(v => !v)}
          className="w-full flex items-center justify-between bg-[var(--bg-input)]/40 rounded-xl p-3 mb-2">
          <span className="flex flex-col items-start gap-0.5 text-left">
            <span className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
              <Truck size={15} /> Self-pickup
            </span>
            <span className="text-[var(--text-muted2)] text-xs">Collects from depot — no route stop</span>
          </span>
          <span className={`inline-block shrink-0 w-10 h-5 rounded-full relative transition-colors ${isPickup ? 'bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${isPickup ? 'translate-x-5' : 'translate-x-0'}`} />
          </span>
        </button>

        {/* Forecast toggle */}
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

        {/* Working hours */}
        <div className="mb-4">
          <div className="text-[var(--text-muted)] text-xs mb-2 flex items-center gap-1"><Clock size={12} /> Working hours</div>
          <div className="flex flex-col gap-1.5">
            {DAYS.map(day => (
              <div key={day} className="flex items-center gap-2">
                <span className="text-[var(--text-muted2)] text-xs w-20 shrink-0">{day.slice(0, 3)}</span>
                <input type="text" value={hours[day]} placeholder="Unavailable"
                  onChange={e => setHours(h => ({ ...h, [day]: e.target.value }))}
                  className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]" />
              </div>
            ))}
          </div>
        </div>

        {/* Contacts */}
        <div className="mb-4">
          <div className="text-[var(--text-muted)] text-xs mb-2">Contacts</div>
          <div className="flex flex-col gap-2 mb-2">
            {contacts.map(c => (
              <div key={c.id} className="bg-[var(--bg-input)]/40 rounded-lg p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[var(--text-primary)] text-sm truncate">{c.name || 'Contact'}</div>
                  <div className="text-[var(--text-muted)] text-xs">{c.phone}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => openWhatsapp(c.phone)} className="text-[var(--accent)] hover:text-[var(--text-accent)] p-1.5 bg-[var(--bg-card)] rounded-lg">
                    <MessageCircle size={14} />
                  </button>
                  <button onClick={() => startCall(c)} className="text-[var(--text-accent)] hover:text-[var(--text-accent2)] p-1.5 bg-[var(--bg-card)] rounded-lg">
                    <Phone size={14} />
                  </button>
                  <button onClick={() => deleteContact(c.id)} className="text-[var(--text-muted2)] hover:text-red-400 p-1.5">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="Name (optional)" value={newContactName} onChange={e => setNewContactName(e.target.value)}
              className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            <input type="tel" placeholder="Phone" value={newContactPhone} onChange={e => setNewContactPhone(e.target.value)}
              className="flex-1 bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            <button onClick={addContact} className="bg-[var(--bg-hover)] hover:bg-[var(--bg-hover2)] text-[var(--text-primary)] rounded-lg px-3">
              <Plus size={14} />
            </button>
          </div>
        </div>

        <button onClick={saveAll} disabled={savingDetail}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-semibold rounded-lg py-2.5">
          {savingDetail ? 'Saving...' : savedFlash ? 'Saved!' : 'Save Changes'}
        </button>
      </div>

      {callTarget && (
        <div className="fixed inset-0 z-[60] bg-[var(--bg-root)]/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setCallTarget(null) }}>
          <div className="bg-[var(--bg-card)]/95 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 w-full max-w-sm shadow-2xl">
            <div className="text-[var(--text-primary)] font-medium mb-3">Did you call {callTarget.name || callTarget.phone}?</div>
            <textarea value={callNote} onChange={e => setCallNote(e.target.value)} placeholder="Log what was discussed (optional)"
              rows={3}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] mb-3" />
            <div className="flex gap-2">
              <button onClick={() => confirmCallLog(false)} className="flex-1 bg-[var(--bg-input)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] text-sm font-medium rounded-lg py-2">
                No
              </button>
              <button onClick={() => confirmCallLog(true)} disabled={savingCall}
                className="flex-1 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-medium rounded-lg py-2">
                {savingCall ? 'Saving...' : 'Yes, log it'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
