import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'

export default function StoreMap({ depot, stores, interactive = true, zoom = 11, onStoreClick, center }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)

  useEffect(() => {
    if (!depot) return
    let map, rafId
    rafId = requestAnimationFrame(() => {
      if (!containerRef.current) return
      map = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: center || [depot.lng, depot.lat],
        zoom,
        interactive,
        attributionControl: interactive,
      })
      if (interactive) map.addControl(new maplibregl.NavigationControl(), 'top-right')
      mapRef.current = map
      map.on('load', () => {
        setTimeout(() => map.resize(), 50)
        stores.forEach(s => {
          if (!s.lat || !s.lng) return
          const el = document.createElement('div')
          const size = interactive ? (s.is_depot ? 'w-4 h-4' : 'w-3.5 h-3.5') : (s.is_depot ? 'w-3 h-3' : 'w-2.5 h-2.5')
          const color = s.is_depot ? 'bg-amber-400' : 'bg-[var(--accent)]'
          el.className = `${size} rounded-full ${color} border-2 border-white shadow-lg ${onStoreClick ? 'cursor-pointer' : ''}`
          if (onStoreClick) el.onclick = () => onStoreClick(s)
          new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map)
        })
      })
    })
    return () => { cancelAnimationFrame(rafId); if (map) map.remove() }
    // eslint-disable-next-line
  }, [depot, stores, interactive])

  return <div ref={containerRef} className="w-full h-full" />
}
