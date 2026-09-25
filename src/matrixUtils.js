import { supabase } from './supabaseClient'

const ORS_MAX_CELLS = 3500 // ORS free-tier limit per matrix request (sources × destinations)
const PAGE = 1000          // Supabase returns at most 1000 rows per request

// Read the whole travel matrix (paginated — a plain select silently stops at 1000 rows).
export async function fetchMatrix(cols = 'from_store_id, to_store_id, seconds, meters') {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('travel_matrix').select(cols)
      .order('id').range(from, from + PAGE - 1)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return all
}

async function routableStores() {
  const { data, error } = await supabase.from('stores').select('id, lat, lng')
    .eq('is_active', true).eq('is_pickup', false).eq('is_d2c', false)
    .not('lat', 'is', null).not('lng', 'is', null)
  if (error) throw error
  return data || []
}

async function orsMatrix(locations, sources, destinations) {
  // functions.invoke sends the logged-in user's token — the edge function rejects anyone else
  const { data, error } = await supabase.functions.invoke('ors-matrix', {
    body: { locations, sources, destinations, metrics: ['distance', 'duration'] },
  })
  if (error) {
    let detail = error.message
    try { detail = (await error.context?.text?.())?.slice(0, 150) || detail } catch { /* ignore */ }
    throw new Error('Route service error: ' + detail)
  }
  if (!data?.durations) throw new Error('Route service returned no durations')
  return data
}

// Request sources × destinations in chunks that fit the ORS cell limit; returns rows.
async function computeRows(userId, stores, srcIdx, dstIdx) {
  const locations = stores.map(s => [s.lng, s.lat])
  const perReq = Math.max(1, Math.floor(ORS_MAX_CELLS / dstIdx.length))
  const rows = []
  for (let k = 0; k < srcIdx.length; k += perReq) {
    const src = srcIdx.slice(k, k + perReq)
    const { durations, distances } = await orsMatrix(locations, src, dstIdx)
    src.forEach((si, a) => dstIdx.forEach((di, b) => {
      if (si === di) return
      const sec = durations[a]?.[b], met = distances?.[a]?.[b]
      if (sec == null) return // unroutable pair — leave it out rather than storing a fake 0
      rows.push({
        user_id: userId, from_store_id: stores[si].id, to_store_id: stores[di].id,
        seconds: Math.round(sec), meters: met == null ? null : Math.round(met),
        computed_at: new Date().toISOString(),
      })
    }))
  }
  return rows
}

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('travel_matrix')
      .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,from_store_id,to_store_id' })
    if (error) throw error
  }
}

let running = null

/**
 * Bring the travel matrix up to date.
 *  - default: only stores with no travel times yet (costs 0 route-service calls if nothing is missing)
 *  - refreshIds: also recompute these stores (e.g. after moving a store's pin)
 *  - full: recompute everything
 * Writes by upsert, so a failure part-way never leaves the matrix wiped.
 * Returns { added, missing } — missing = number of stores that were filled in.
 */
export function syncMatrix({ full = false, refreshIds = [] } = {}) {
  if (running) return running.then(() => syncMatrix({ full, refreshIds })) // queue, never run two at once
  running = (async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { added: 0, missing: 0 }
    const stores = await routableStores()
    if (stores.length < 2) return { added: 0, missing: 0 }
    const allIdx = stores.map((_, i) => i)
    let rows
    let missing = 0
    if (full) {
      rows = await computeRows(user.id, stores, allIdx, allIdx)
      missing = stores.length
    } else {
      const existing = await fetchMatrix('from_store_id, to_store_id')
      const hasFrom = new Set(existing.map(r => r.from_store_id))
      const hasTo = new Set(existing.map(r => r.to_store_id))
      const force = new Set(refreshIds)
      const need = allIdx.filter(i => force.has(stores[i].id) || !hasFrom.has(stores[i].id) || !hasTo.has(stores[i].id))
      if (!need.length) return { added: 0, missing: 0 }
      missing = need.length
      rows = [
        ...await computeRows(user.id, stores, need, allIdx),  // new stores → everyone
        ...await computeRows(user.id, stores, allIdx, need),  // everyone → new stores
      ]
    }
    // A pair between two new stores comes out of both passes; one upsert can't touch a row twice
    const unique = [...new Map(rows.map(r => [`${r.from_store_id}_${r.to_store_id}`, r])).values()]
    await upsertRows(unique)
    return { added: unique.length, missing }
  })()
  const p = running
  const clear = () => { if (running === p) running = null }
  p.then(clear, clear)
  return p
}

// How many routable stores have no travel times yet (no route-service call).
export async function countMissing() {
  const [stores, existing] = await Promise.all([routableStores(), fetchMatrix('from_store_id')])
  const has = new Set(existing.map(r => r.from_store_id))
  return stores.filter(s => !has.has(s.id)).length
}
