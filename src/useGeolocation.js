import { useState, useEffect } from 'react'

export function useGeolocation() {
  const [position, setPosition] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | granted | denied | unavailable

  function request() {
    if (!navigator.geolocation) { setStatus('unavailable'); return }
    setStatus('loading')
    navigator.geolocation.getCurrentPosition(
      pos => { setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setStatus('granted') },
      () => setStatus('denied'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }

  useEffect(() => { request() }, [])

  return { position, status, retry: request }
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Google text search can return several shops with the same name (other branches).
// When we know where the store is, take the result nearest to it — and only if it's
// within maxKm, so a same-named shop across town is never picked by mistake.
export function pickNearestPlace(places, lat, lng, maxKm = 1) {
  if (!places?.length) return null
  if (lat == null || lng == null || lat === '' || lng === '') return places[0]
  let best = null, bestKm = Infinity
  places.forEach(p => {
    const la = p.location?.latitude, ln = p.location?.longitude
    if (la == null || ln == null) return
    const km = haversineKm(Number(lat), Number(lng), la, ln)
    if (km < bestKm) { bestKm = km; best = p }
  })
  return bestKm <= maxKm ? best : null
}
