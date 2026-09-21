import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { Search, MapPin, Star, Plus, Check, Loader2, RefreshCw, ChevronDown, Ban, EyeOff, Eye, X, Settings } from 'lucide-react'

const KEY = import.meta.env.VITE_GOOGLE_PLACES_KEY
const PLACES_URL = 'https://places.googleapis.com/v1/places'
const FIELD_MASK = 'places.id,places.displayName,places.location,places.formattedAddress,places.types,places.rating,places.userRatingCount,places.businessStatus'
const DEFAULT_TYPES = ['supermarket', 'grocery_store', 'convenience_store']
const CACHE_KEY = 'prosa_prospect_search'
const CUSTOM_CHAINS_KEY = 'prosa_custom_chains'

const CHAINS = [
  'palm tree', 'vishal mega mart', 'vishal ', 'reliance fresh', 'reliance smart',
  'reliance retail', 'd-mart', 'dmart', 'lulu', 'grand hyper', 'more supermarket',
  'more retail', "spencer's", 'spencers', 'star bazaar', 'nilgiris', 'mk retail',
  'q-mart', 'ratnadeep', "namdhari's", 'namdharis', 'heritage fresh', 'easyday',
  'metro cash', 'fabmall', 'big bazaar', 'milma', 'consumerfed', 'triveni',
  'popular bazaar', 'rp mall', 'kalyan', 'mymoon', 'margin free',
  'instamart', 'we mart', 'wemart', 'miniso',
]

function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function scoreOf(p) {
  const r = p.rating || 0
  const n = p.userRatingCount || 0
  return +(r * Math.log10(n + 1)).toFixed(2)
}
function isChain(name, custom) {
  const n = (name || '').toLowerCase()
  if (CHAINS.some(c => n.includes(c))) return true
  if (custom && custom.some(c => c && n.includes(c))) return true
  return false
}
function wordSuggestions(name) {
  const words = (name || '').replace(/[(),.]/g, '').split(/\s+/).filter(Boolean)
  const stopwords = new Set(['the','a','an','we','my','and','of','for','on','in','to','&','-'])
  const seen = new Set()
  const out = []
  for (const w of words) {
    const wl = w.toLowerCase()
    if (wl.length < 3) continue
    if (stopwords.has(wl)) continue
    if (seen.has(wl)) continue
    seen.add(wl)
    out.push(wl)
  }
  return out
}
function brandGuess(name) {
  const words = (name || '').replace(/[(),]/g, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const stopwords = ['the', 'a', 'an', 'we', 'my']
  const first = words[0].toLowerCase()
  if (first.length <= 3 || stopwords.includes(first)) {
    return words.slice(0, 2).join(' ').toLowerCase()
  }
  return first
}

export default function ProspectFinderScreen() {
  const [mode, setMode] = useState('area')
  const [query, setQuery] = useState('')
  const [stores, setStores] = useState([])
  const [anchorStore, setAnchorStore] = useState('')
  const [radiusKm, setRadiusKm] = useState(3)
  const [types, setTypes] = useState(DEFAULT_TYPES)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState([])
  const [center, setCenter] = useState(null)
  const [existingPlaceIds, setExistingPlaceIds] = useState(new Set())
  const [adding, setAdding] = useState(null)
  const [hideChains, setHideChains] = useState(true)
  const [customChains, setCustomChains] = useState([])
  const [toast, setToast] = useState(null)
  const [showManage, setShowManage] = useState(false)
  const [hidePicker, setHidePicker] = useState(null) // { place, custom }
  const [crossCheck, setCrossCheck] = useState(null) // { term, count, capped, names, error }
  const [crossCheckLoading, setCrossCheckLoading] = useState(false)
  const toastTimer = useRef(null)

  useEffect(() => {
    supabase.from('stores')
      .select('id, name, lat, lng, place_id, pipeline_status')
      .eq('is_active', true).eq('is_depot', false).order('name')
      .then(({ data }) => {
        if (data) {
          setStores(data)
          setExistingPlaceIds(new Set(data.filter(s => s.place_id).map(s => s.place_id)))
        }
      })
    try {
      const cRaw = localStorage.getItem(CUSTOM_CHAINS_KEY)
      if (cRaw) setCustomChains(JSON.parse(cRaw))
    } catch {}
    try {
      const raw = sessionStorage.getItem(CACHE_KEY)
      if (raw) {
        const c = JSON.parse(raw)
        setMode(c.mode || 'area'); setQuery(c.query || '')
        setAnchorStore(c.anchorStore || ''); setRadiusKm(c.radiusKm || 3)
        setTypes(c.types || DEFAULT_TYPES)
        setResults(c.results || []); setCenter(c.center || null)
        if (c.hideChains !== undefined) setHideChains(c.hideChains)
      }
    } catch {}
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [])

  useEffect(() => {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ mode, query, anchorStore, radiusKm, types, results, center, hideChains }))
    } catch {}
  }, [mode, query, anchorStore, radiusKm, types, results, center, hideChains])

  async function search() {
    if (!KEY) { setError('Google Places key not configured'); return }
    setError(''); setBusy(true); setResults([])
    try {
      let lat, lng, label
      if (mode === 'area') {
        if (!query.trim()) { setError('Enter a pincode or locality'); setBusy(false); return }
        const geoRes = await fetch(`${PLACES_URL}:searchText`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': KEY,
            'X-Goog-FieldMask': 'places.location,places.formattedAddress,places.displayName',
          },
          body: JSON.stringify({ textQuery: query.trim() + ' Kerala India', maxResultCount: 1 })
        })
        if (!geoRes.ok) throw new Error(`Geocode failed: ${geoRes.status}`)
        const geo = await geoRes.json()
        const first = geo.places?.[0]
        if (!first) { setError('Location not found'); setBusy(false); return }
        lat = first.location.latitude; lng = first.location.longitude
        label = first.formattedAddress || query
      } else {
        const s = stores.find(x => x.id === anchorStore)
        if (!s || !s.lat || !s.lng) { setError('Pick a store with a location'); setBusy(false); return }
        lat = s.lat; lng = s.lng; label = s.name
      }
      // Text Search matches semantically — catches organic/health/specialty shops that
      // Nearby Search would drop for having non-standard Google primary types
      const typeTerms = { supermarket: 'supermarket', grocery_store: 'grocery', convenience_store: 'convenience store', bakery: 'bakery', cafe: 'cafe' }
      const textQuery = types.map(t => typeTerms[t] || t).join(' OR ')
      const nearRes = await fetch(`${PLACES_URL}:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery,
          locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusKm * 1000 } },
          maxResultCount: 20,
        })
      })
      if (!nearRes.ok) {
        const txt = await nearRes.text()
        throw new Error(`Search failed: ${nearRes.status} ${txt.slice(0, 200)}`)
      }
      const data = await nearRes.json()
      const enriched = (data.places || [])
        .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
        .map(p => ({
          place_id: p.id,
          name: p.displayName?.text || 'Unnamed',
          address: p.formattedAddress || '',
          lat: p.location.latitude,
          lng: p.location.longitude,
          types: p.types || [],
          rating: p.rating || null,
          reviews: p.userRatingCount || 0,
          distance_km: +distKm(lat, lng, p.location.latitude, p.location.longitude).toFixed(2),
          score: scoreOf(p),
          existing: existingPlaceIds.has(p.id),
        }))
        .filter(p => p.distance_km <= radiusKm)
        .sort((a, b) => b.score - a.score)
      setResults(enriched)
      setCenter({ lat, lng, label })
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  async function addProspect(p) {
    setAdding(p.place_id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { error: insErr } = await supabase.from('stores').insert({
        user_id: user.id,
        name: p.name,
        address: p.address,
        place_id: p.place_id,
        lat: p.lat,
        lng: p.lng,
        pipeline_status: 'prospect',
        pipeline_updated_by: 'user',
        is_active: true,
        is_depot: false,
      })
      if (insErr) throw insErr
      setExistingPlaceIds(prev => new Set([...prev, p.place_id]))
      setResults(rs => rs.map(r => r.place_id === p.place_id ? { ...r, existing: true } : r))
    } catch (e) {
      alert('Add failed: ' + e.message)
    } finally { setAdding(null) }
  }

  function saveCustomChains(next) {
    setCustomChains(next)
    try { localStorage.setItem(CUSTOM_CHAINS_KEY, JSON.stringify(next)) } catch {}
  }

  function hideBrand(brandStr) {
    const b = (brandStr || '').trim().toLowerCase()
    if (!b || b.length < 3) return
    if (customChains.includes(b)) return
    saveCustomChains([...customChains, b])
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
    setToast({ brand: b })
  }

  function undoLastHide() {
    if (!toast) return
    saveCustomChains(customChains.filter(c => c !== toast.brand))
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(null)
  }

  function removeCustomChain(brand) {
    saveCustomChains(customChains.filter(c => c !== brand))
  }

  async function runCrossCheck(term) {
    const t = (term || '').trim().toLowerCase()
    if (!t || t.length < 3) return
    setCrossCheckLoading(true)
    try {
      const res = await fetch(`${PLACES_URL}:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress',
        },
        body: JSON.stringify({ textQuery: t + ' Kerala India', maxResultCount: 20 })
      })
      if (!res.ok) throw new Error(`Kerala check failed: ${res.status}`)
      const data = await res.json()
      const matches = (data.places || []).filter(pl => (pl.displayName?.text || '').toLowerCase().includes(t))
      setCrossCheck({ term: t, count: matches.length, capped: matches.length >= 20, names: matches.map(pl => ({ name: pl.displayName?.text || '', address: pl.formattedAddress || '' })) })
    } catch (e) {
      setCrossCheck({ term: t, error: e.message })
    } finally { setCrossCheckLoading(false) }
  }
  function openHidePicker(p) {
    setHidePicker({ place: p, custom: brandGuess(p.name) })
  }

  const toggleType = t => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])

  const chainCount = results.filter(r => isChain(r.name, customChains)).length
  const visibleResults = hideChains ? results.filter(p => !isChain(p.name, customChains)) : results

  // Helpers for picker preview counts
  const countMatches = sub => {
    const s = (sub || '').trim().toLowerCase()
    if (!s) return 0
    return results.filter(r => r.name.toLowerCase().includes(s)).length
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 relative">
      <div className="flex bg-[var(--bg-input)] rounded-xl p-1">
        <button onClick={() => setMode('area')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'area' ? 'bg-[var(--bg-card)] text-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          New area
        </button>
        <button onClick={() => setMode('route')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'route' ? 'bg-[var(--bg-card)] text-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Around a store
        </button>
      </div>

      {mode === 'area' ? (
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)]" />
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Pincode or locality (e.g. 683572, Angamaly)"
            className="w-full pl-9 pr-3 py-2.5 bg-[var(--bg-input)] rounded-xl text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted2)] outline-none border border-transparent focus:border-[var(--accent)]/40" />
        </div>
      ) : (
        <div className="relative">
          <select value={anchorStore} onChange={e => setAnchorStore(e.target.value)}
            className="w-full pl-3 pr-9 py-2.5 bg-[var(--bg-input)] rounded-xl text-sm text-[var(--text-primary)] outline-none appearance-none border border-transparent focus:border-[var(--accent)]/40">
            <option value="">Pick an existing store…</option>
            {stores.filter(s => s.lat && s.lng).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted2)] pointer-events-none" />
        </div>
      )}

      <div>
        <div className="flex justify-between text-xs text-[var(--text-muted2)] mb-1">
          <span>Radius</span>
          <span className="text-[var(--text-secondary)] font-medium">{radiusKm} km</span>
        </div>
        <input type="range" min="1" max="10" step="0.5" value={radiusKm}
          onChange={e => setRadiusKm(+e.target.value)}
          className="w-full accent-[var(--accent)]" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[['supermarket','Supermarket'],['grocery_store','Grocery'],['convenience_store','Convenience'],['bakery','Bakery'],['cafe','Cafe']].map(([t, label]) => (
          <button key={t} onClick={() => toggleType(t)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${types.includes(t) ? 'bg-[var(--accent)]/15 text-[var(--text-accent)] border border-[var(--accent)]/30' : 'bg-[var(--bg-input)] text-[var(--text-muted2)] border border-transparent'}`}>
            {label}
          </button>
        ))}
      </div>

      <button onClick={search}
        disabled={busy || (mode === 'area' ? !query.trim() : !anchorStore) || types.length === 0}
        className="w-full py-2.5 rounded-xl bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
        {busy ? <><Loader2 size={16} className="animate-spin" /> Searching…</> : <><Search size={16} /> Find prospects</>}
      </button>

      {error && (<div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</div>)}

      {results.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={() => setHideChains(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${hideChains ? 'bg-[var(--accent)]/15 text-[var(--text-accent)] border border-[var(--accent)]/30' : 'bg-[var(--bg-input)] text-[var(--text-muted2)] border border-transparent'}`}>
              {hideChains ? <EyeOff size={12} /> : <Eye size={12} />}
              {hideChains ? `Chains hidden (${chainCount})` : `Show all — ${chainCount} chains`}
            </button>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowManage(true)}
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                <Settings size={12} /> Manage
              </button>
              <button onClick={search}
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
          </div>
          <div className="text-xs text-[var(--text-muted2)]">
            {visibleResults.length} of {results.length} around <span className="text-[var(--text-secondary)]">{center?.label}</span>
          </div>
        </>
      )}

      <div className="space-y-2">
        {visibleResults.map(p => {
          const chain = isChain(p.name, customChains)
          return (
            <div key={p.place_id}
              className={`p-3 rounded-xl border transition-opacity ${p.existing || chain ? 'bg-[var(--bg-input)]/40 border-white/5 opacity-60' : 'bg-[var(--bg-card)] border-white/10'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[var(--text-primary)] text-sm truncate flex items-center gap-1.5">
                    <a href={p.place_id && !p.place_id.startsWith('local-') ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name || "")}&query_place_id=${p.place_id}` : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer" className="truncate hover:text-[var(--text-accent)] hover:underline">{p.name}</a>
                    {chain && <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 font-medium">CHAIN</span>}
                  </div>
                  <div className="text-xs text-[var(--text-muted2)] mt-0.5 flex items-center gap-1 truncate">
                    <MapPin size={11} className="shrink-0" /> {p.address}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] mt-1 flex items-center gap-3">
                    {p.rating != null && (
                      <span className="flex items-center gap-0.5">
                        <Star size={11} className="fill-amber-400 text-amber-400" />
                        <span className="text-[var(--text-secondary)]">{p.rating}</span>
                        <span className="text-[var(--text-muted2)]">({p.reviews})</span>
                      </span>
                    )}
                    <span>{p.distance_km} km</span>
                    <span className="text-[var(--text-muted2)]">score {p.score}</span>
                  </div>
                </div>
                <div className="shrink-0 flex flex-col gap-1">
                  <button onClick={() => addProspect(p)}
                    disabled={p.existing || adding === p.place_id}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ${p.existing ? 'bg-white/5 text-[var(--text-muted2)] cursor-not-allowed' : 'bg-[var(--accent)]/15 text-[var(--text-accent)] border border-[var(--accent)]/30 hover:bg-[var(--accent)]/25'}`}>
                    {p.existing ? <><Check size={12} /> Added</> : adding === p.place_id ? <Loader2 size={12} className="animate-spin" /> : <><Plus size={12} /> Prospect</>}
                  </button>
                  {!p.existing && !chain && (
                    <button onClick={() => openHidePicker(p)}
                      className="px-2.5 py-1 rounded-lg text-[10px] font-medium flex items-center gap-1 bg-white/5 text-[var(--text-muted2)] hover:bg-white/10">
                      <Ban size={10} /> Hide
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {!busy && results.length === 0 && center && (
          <div className="text-xs text-[var(--text-muted2)] text-center py-6">No prospects found in this area.</div>
        )}
        {!busy && results.length > 0 && visibleResults.length === 0 && (
          <div className="text-xs text-[var(--text-muted2)] text-center py-6">All results filtered as chains. Toggle above to see them.</div>
        )}
      </div>

      {/* Hide picker */}
      {hidePicker && (() => {
        const p = hidePicker.place
        const full = p.name.toLowerCase()
        const words = wordSuggestions(p.name)
        const previewMatches = (sub) => {
          const t = (sub || '').trim().toLowerCase()
          if (!t || t.length < 3) return []
          return results.filter(r => r.name.toLowerCase().includes(t))
        }
        const currentCustom = hidePicker.custom.trim().toLowerCase()
        const currentMatches = previewMatches(currentCustom)
        const ccMatchesTerm = crossCheck && crossCheck.term === currentCustom
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center pb-28 sm:p-4" onClick={() => setHidePicker(null)}>
            <div className="bg-[var(--bg-card)] w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-white/10 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
              <div className="p-4 border-b border-white/10 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--text-primary)] truncate">Hide "{p.name}"</div>
                  <div className="text-[10px] text-[var(--text-muted2)] mt-0.5">Applies to this AND all future searches on this device</div>
                </div>
                <button onClick={() => setHidePicker(null)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0">
                  <X size={18} />
                </button>
              </div>
              <div className="overflow-y-auto flex-1 p-4 space-y-3">
                <button onClick={() => { hideBrand(full); setHidePicker(null) }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-3 bg-[var(--bg-input)] rounded-lg hover:bg-white/10 text-left">
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--text-primary)]">Just this outlet</div>
                    <div className="text-xs text-[var(--text-muted2)] truncate">"{full}"</div>
                  </div>
                  <span className="text-xs text-[var(--text-muted)] shrink-0">{previewMatches(full).length} here</span>
                </button>

                {words.length > 0 && (
                  <div className="p-3 bg-[var(--bg-input)] rounded-lg">
                    <div className="text-xs text-[var(--text-muted2)] mb-2">Or hide by a word from the name — count is matches in THIS list only:</div>
                    <div className="flex flex-wrap gap-1.5">
                      {words.map(w => {
                        const c = previewMatches(w).length
                        const active = currentCustom === w
                        return (
                          <button key={w}
                            onClick={() => setHidePicker({ ...hidePicker, custom: w })}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors ${active ? 'bg-[var(--accent)]/15 text-[var(--text-accent)] border-[var(--accent)]/40' : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-white/10 hover:bg-white/5'}`}>
                            <span>{w}</span>
                            <span className={active ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}>{c}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="p-3 bg-[var(--bg-input)] rounded-lg">
                  <div className="text-sm text-[var(--text-primary)] mb-2">Custom substring</div>
                  <div className="flex gap-2">
                    <input value={hidePicker.custom}
                      onChange={e => setHidePicker({ ...hidePicker, custom: e.target.value })}
                      placeholder="text to match"
                      className="flex-1 px-2 py-1.5 bg-[var(--bg-card)] rounded text-sm text-[var(--text-primary)] outline-none border border-white/10 focus:border-[var(--accent)]/40" />
                    <button onClick={() => { hideBrand(hidePicker.custom); setHidePicker(null) }}
                      disabled={!currentCustom || currentCustom.length < 3}
                      className="px-3 py-1.5 rounded bg-[var(--accent)]/15 text-[var(--text-accent)] border border-[var(--accent)]/30 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed">
                      Hide
                    </button>
                  </div>
                </div>

                {currentCustom.length >= 3 && (
                  <div className="px-3 py-2 border border-white/10 rounded-lg bg-[var(--bg-input)]/40 space-y-2">
                    <div className="text-xs text-[var(--text-muted2)]">
                      <span className="text-[var(--text-secondary)] font-medium">{currentMatches.length}</span> in these results:
                    </div>
                    {currentMatches.length > 0 && (
                      <div className="space-y-0.5">
                        {currentMatches.slice(0, 5).map(m => (
                          <div key={m.place_id} className="text-xs text-[var(--text-secondary)] truncate">• {m.name}</div>
                        ))}
                        {currentMatches.length > 5 && (
                          <div className="text-xs text-[var(--text-muted2)]">…and {currentMatches.length - 5} more</div>
                        )}
                      </div>
                    )}

                    <div className="pt-2 border-t border-white/5">
                      {!ccMatchesTerm ? (
                        <button onClick={() => runCrossCheck(currentCustom)} disabled={crossCheckLoading}
                          className="text-xs text-[var(--text-accent)] hover:underline flex items-center gap-1 disabled:opacity-50">
                          {crossCheckLoading
                            ? <><Loader2 size={11} className="animate-spin" /> Checking across Kerala…</>
                            : <><Search size={11} /> Check "{currentCustom}" across Kerala (1 API call)</>}
                        </button>
                      ) : crossCheck.error ? (
                        <div className="text-xs text-red-400">{crossCheck.error}</div>
                      ) : (
                        <div className="space-y-1">
                          <div className="text-xs text-[var(--text-muted2)]">
                            <span className="text-[var(--text-secondary)] font-medium">{crossCheck.count}{crossCheck.capped ? '+' : ''}</span> "{crossCheck.term}" outlets found in Kerala{crossCheck.capped ? ' (Google caps at 20 — likely more)' : ''}:
                          </div>
                          {crossCheck.names.slice(0, 8).map((n, i) => (
                            <div key={i} className="text-xs text-[var(--text-secondary)] truncate" title={n.address}>• {n.name}</div>
                          ))}
                          {crossCheck.names.length > 8 && (
                            <div className="text-xs text-[var(--text-muted2)]">…and {crossCheck.names.length - 8} more</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Undo toast */}
      {toast && (
        <div className="fixed bottom-24 left-4 right-4 max-w-md mx-auto z-50 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-white/15 shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-xl">
          <span className="text-xs text-[var(--text-secondary)] truncate">
            Hidden: <span className="text-[var(--text-primary)] font-medium">{toast.brand}</span>
          </span>
          <button onClick={undoLastHide}
            className="shrink-0 text-xs font-semibold text-[var(--text-accent)] hover:underline px-2">
            UNDO
          </button>
        </div>
      )}

      {/* Manage sheet */}
      {showManage && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center pb-28 sm:p-4" onClick={() => setShowManage(false)}>
          <div className="bg-[var(--bg-card)] w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-white/10 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Hidden chains</div>
              <button onClick={() => setShowManage(false)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-5">
              <div>
                <div className="text-xs text-[var(--text-muted2)] mb-2 flex items-center justify-between">
                  <span>Your list ({customChains.length})</span>
                  {customChains.length > 0 && (
                    <button onClick={() => saveCustomChains([])}
                      className="text-[var(--text-muted)] hover:text-red-400 text-[11px]">Clear all</button>
                  )}
                </div>
                {customChains.length === 0 ? (
                  <div className="text-xs text-[var(--text-muted2)] italic px-3 py-4 bg-[var(--bg-input)]/40 rounded-lg text-center">
                    Nothing here yet. Tap "Hide" on any result to add it.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {customChains.map(c => (
                      <div key={c} className="flex items-center justify-between px-3 py-2 bg-[var(--bg-input)] rounded-lg">
                        <span className="text-sm text-[var(--text-primary)]">{c}</span>
                        <button onClick={() => removeCustomChain(c)} className="text-[var(--text-muted)] hover:text-red-400 p-1">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted2)] mb-2">Built-in ({CHAINS.length}) — edit in code</div>
                <div className="flex flex-wrap gap-1">
                  {CHAINS.map(c => (
                    <span key={c} className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-muted)]">{c}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
