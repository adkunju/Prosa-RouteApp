import { supabase } from './supabaseClient'

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
  const [{ data: dl }, { data: adj }] = await Promise.all([
    supabase.from('delivery_lines').select('batch_id, qty_delivered').not('batch_id', 'is', null),
    supabase.from('stock_adjustments').select('batch_id, qty'),
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
