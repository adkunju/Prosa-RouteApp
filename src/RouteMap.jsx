import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import './maplibreSetup'
import { supabase } from './supabaseClient'

// Road route through the points in order, from the route service. Cached per set of points
// for the session, so reopening the screen or re-rendering doesn't ask again.
const roadCache = new Map()
async function fetchRoadRoute(coords) {
  const key = coords.map(c => c.map(n => n.toFixed(5)).join(',')).join(';')
  if (roadCache.has(key)) return roadCache.get(key)
  try {
    const raw = sessionStorage.getItem('prosa_road_' + key)
    if (raw) { const v = JSON.parse(raw); roadCache.set(key, v); return v }
  } catch { /* ignore */ }
  const { data, error } = await supabase.functions.invoke('ors-directions', { body: { coordinates: coords } })
  if (error || !data?.coordinates?.length) throw new Error(error?.message || data?.error || 'no route')
  roadCache.set(key, data.coordinates)
  try { sessionStorage.setItem('prosa_road_' + key, JSON.stringify(data.coordinates)) } catch { /* storage full: fine */ }
  return data.coordinates
}

// Travel line: green where the trip starts, through amber, to red where it ends, so the
// direction of travel can be read at a glance. Drawn under the stop markers.
function ensureRouteLayer(map) {
  if (map.getSource('route')) return
  // lineMetrics lets the colour follow the distance along the line
  map.addSource('route', { type: 'geojson', lineMetrics: true, data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} } })
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } })
  map.addLayer({ id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': 4,
      'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#16a34a', 0.5, '#f59e0b', 1, '#dc2626'],
    } })
}

// Desktop-only map for the Delivery screen.
// Shows the depot and every stop, numbered in visit order. The coloured line follows the
// roads through the remaining stops in order (straight lines if the route service is unavailable).
// stops: [{ id, name, lat, lng, state: 'todo' | 'done' | 'skipped', n }]
export default function RouteMap({ depot, stops }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const popupsRef = useRef([])
  const fittedRef = useRef('')
  const routeReq = useRef(0)
  const [roadState, setRoadState] = useState('none') // none | loading | road | straight
  const latest = useRef({ depot, stops })
  latest.current = { depot, stops }

  function draw() {
    const map = mapRef.current
    const { depot, stops } = latest.current
    if (!map || !depot) return
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    popupsRef.current.forEach(p => p.remove())
    popupsRef.current = []

    // Hovering a pin shows a small card with the store name and details (built as text, not HTML)
    const add = (lng, lat, className, text, heading, lines = []) => {
      const el = document.createElement('div')
      el.className = className + ' cursor-pointer'
      el.textContent = text
      const box = document.createElement('div')
      box.className = 'text-xs leading-snug'
      const h = document.createElement('div')
      h.className = 'font-semibold text-[13px] text-gray-900 mb-0.5'
      h.textContent = heading
      box.appendChild(h)
      lines.forEach(l => { const d = document.createElement('div'); d.className = 'text-gray-600'; d.textContent = l; box.appendChild(d) })
      const popup = new maplibregl.Popup({ offset: 16, closeButton: false, closeOnClick: false, maxWidth: '260px' }).setDOMContent(box)
      el.addEventListener('mouseenter', () => popup.setLngLat([lng, lat]).addTo(map))
      el.addEventListener('mouseleave', () => popup.remove())
      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map))
      popupsRef.current.push(popup)
    }
    const base = 'flex items-center justify-center rounded-full border-2 border-white shadow-lg text-[11px] font-bold'
    const placed = stops.filter(s => s.lat && s.lng)
    // done and skipped first so the remaining stops sit on top
    placed.filter(s => s.state !== 'todo').forEach(s =>
      add(s.lng, s.lat, `${base} w-5 h-5 bg-gray-400 text-white opacity-80`, s.state === 'done' ? '✓' : '–', s.name, s.info || []))
    placed.filter(s => s.state === 'todo').forEach(s =>
      add(s.lng, s.lat, `${base} w-6 h-6 bg-[var(--accent)] text-white`, String(s.n), `${s.n}. ${s.name}`, s.info || []))
    if (depot.lat && depot.lng) add(depot.lng, depot.lat, `${base} w-6 h-6 bg-amber-400 text-white`, '', 'Depot', ['Start and end of the route'])

    const todo = placed.filter(s => s.state === 'todo').sort((a, b) => a.n - b.n)
    const coords = todo.length && depot.lat && depot.lng
      ? [[depot.lng, depot.lat], ...todo.map(s => [s.lng, s.lat]), [depot.lng, depot.lat]]
      : []
    ensureRouteLayer(map)
    const src = map.getSource('route')
    const setLine = c => src && src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} })
    // Straight lines first (instant), then swap in the road route when it arrives.
    // If the route service fails, the straight lines stay.
    setLine(coords)
    const reqId = ++routeReq.current
    setRoadState(coords.length >= 2 ? 'loading' : 'none')
    if (coords.length >= 2 && coords.length <= 50) {
      fetchRoadRoute(coords)
        .then(road => { if (reqId === routeReq.current && mapRef.current === map) { setLine(road); setRoadState('road') } })
        .catch(e => { if (reqId === routeReq.current) { console.warn('road route failed', e); setRoadState('straight') } })
    } else if (coords.length > 50) setRoadState('straight')

    // Re-frame the map only when the set of stops changes, not on every re-order
    const key = [depot.id, ...placed.map(s => s.id).sort()].join(',')
    if (key !== fittedRef.current) {
      fittedRef.current = key
      const pts = [...placed.map(s => [s.lng, s.lat]), ...(depot.lat && depot.lng ? [[depot.lng, depot.lat]] : [])]
      if (pts.length === 1) map.jumpTo({ center: pts[0], zoom: 12 })
      else if (pts.length > 1) {
        const b = new maplibregl.LngLatBounds(pts[0], pts[0])
        pts.forEach(p => b.extend(p))
        map.fitBounds(b, { padding: 70, maxZoom: 14, duration: 0 })
      }
    }
  }

  // Create the map once the depot is known
  const hasDepot = !!(depot && depot.lat && depot.lng)
  useEffect(() => {
    if (!hasDepot || !containerRef.current) return
    const d = latest.current.depot
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [d.lng, d.lat],
      zoom: 11,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.on('load', () => {
      ensureRouteLayer(map)
      mapRef.current = map
      map.resize()
      draw()
    })
    return () => { mapRef.current = null; markersRef.current = []; fittedRef.current = ''; map.remove() }
    // eslint-disable-next-line
  }, [hasDepot])

  // Redraw when the stops, their order or their status change
  const signature = JSON.stringify(stops.map(s => [s.id, s.lat, s.lng, s.state, s.n, s.info]))
  useEffect(() => { draw() }, [signature]) // eslint-disable-line

  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-full" />
      {roadState !== 'none' && (
        <span className="absolute bottom-3 left-3 bg-[var(--bg-root)]/85 backdrop-blur-md text-[var(--text-secondary)] text-xs px-2.5 py-1 rounded-full shadow flex items-center gap-2">
          <span className="inline-block w-10 h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg,#16a34a,#f59e0b,#dc2626)' }} />
          {roadState === 'road' ? 'Road route · start → end' : roadState === 'loading' ? 'Loading road route…' : 'Road route unavailable · straight lines shown'}
        </span>
      )}
    </div>
  )
}
