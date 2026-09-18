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
