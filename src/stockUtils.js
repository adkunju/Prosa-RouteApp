import { supabase } from './supabaseClient'
import { fetchAll } from './dbUtils'

export const ADJUST_REASONS = [
  { key: 'self_consumed', label: 'Self consumed' },
  { key: 'damaged', label: 'Damaged' },
  { key: 'sample', label: 'Sample / free' },
  { key: 'other', label: 'Other' },
]
export const reasonLabel = k => ADJUST_REASONS.find(r => r.key === k)?.label || k

// Single source of truth for how much of each batch has left the depot.
// used[batch_id] = delivered + adjusted (self consumed, damaged, etc.)
export async function fetchBatchUsage() {
  const [dl, adj] = await Promise.all([
    fetchAll(() => supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null).order('id')),
    fetchAll(() => supabase.from('stock_adjustments').select('batch_id, qty').order('id')),
  ])
  const delivered = {}, adjusted = {}, used = {}
  ;(dl || []).forEach(d => { delivered[d.batch_id] = (delivered[d.batch_id] || 0) + (d.qty_delivered || 0) })
  ;(adj || []).forEach(a => { adjusted[a.batch_id] = (adjusted[a.batch_id] || 0) + (a.qty || 0) })
  new Set([...Object.keys(delivered), ...Object.keys(adjusted)]).forEach(id => {
    used[id] = (delivered[id] || 0) + (adjusted[id] || 0)
  })
  return { used, delivered, adjusted }
}

// Tell every screen that caches stock (Schedule, Dashboard, Delivery) to reload.
export function notifyStockChanged() {
  sessionStorage.removeItem('prosa_schedule_cache')
  window.dispatchEvent(new CustomEvent('prosa:stock_changed'))
}

// Split a delivery of `qty` across batches: the chosen batch first, then the oldest other
// batches with stock (first-in first-out). batches: [{ id, produced_on, avail }]
// Returns { parts: [{ batch_id, produced_on, qty }], short } — short > 0 means not enough stock.
export function splitAcrossBatches(batches, selectedId, qty) {
  let need = Math.max(0, Number(qty) || 0)
  const ordered = [
    ...batches.filter(b => b.id === selectedId),
    ...batches.filter(b => b.id !== selectedId).sort((a, b) => a.produced_on.localeCompare(b.produced_on)),
  ]
  const parts = []
  for (const b of ordered) {
    if (need <= 0) break
    const take = Math.min(need, Math.max(0, b.avail))
    if (take > 0) { parts.push({ batch_id: b.id, produced_on: b.produced_on, qty: take }); need -= take }
  }
  return { parts, short: need }
}

// Friendly text for a database "batch over" refusal
export function batchErrorText(msg) {
  const m = /BATCH_OVER: (.*)/.exec(msg || '')
  return m ? `Not enough stock — ${m[1]}. Refresh and try again.` : msg
}

// Before creating stock: is there already a batch of these products for this production date?
// rows: [{ sku_id, qty }]. Returns true when it's OK to go ahead (nothing exists, or the user confirmed).
export async function confirmNoDuplicateBatch(producedOn, rows) {
  const skuIds = [...new Set(rows.filter(r => Number(r.qty) > 0).map(r => r.sku_id))]
  if (!producedOn || !skuIds.length) return true
  const { data } = await supabase.from('production_batches')
    .select('qty, is_spare, created_at, skus(name)').eq('produced_on', producedOn).in('sku_id', skuIds)
  if (!data?.length) return true
  const [y, m, d] = producedOn.split('-').map(Number)
  const day = new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const list = data.map(b => {
    const when = new Date(b.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    return `• ${b.skus?.name || 'Product'}: ${b.qty} pcs${b.is_spare ? ' (spare)' : ''} — logged ${when}`
  }).join('\n')
  return window.confirm(`Stock already exists for production date ${day}:\n\n${list}\n\nAdd another batch anyway?`)
}
