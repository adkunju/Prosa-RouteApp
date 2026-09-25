import { supabase } from './supabaseClient'
import { fetchAll } from './dbUtils'

// WhatsApp opening messages, one per store group. {store} is replaced with the store's name.
//  prospect  → status 'prospect'
//  followup  → warm, cold, dormant, dropped (already in touch, not supplying)
//  store     → onboard (and unknown status)
export const WA_GROUPS = ['prospect', 'followup', 'store']
export const WA_DEFAULTS = {
  wa_msg_prospect: 'Hello {store} team, this is Antony from Prosa. We make fresh Idli/Dosa batter and chappathi, delivered around Kochi on sale-or-return. Could we drop by with samples?',
  wa_msg_followup: 'Hello {store} team, this is Antony from Prosa, following up on our earlier conversation about our Idli/Dosa batter and chappathi. ',
  wa_msg_store: 'Hello {store} team, this is Antony from Prosa. ',
  wa_link_prospect: '',
  wa_link_followup: '',
  wa_link_store: '',
  // Sent from the "Delivery confirmed" popup to the store's D contact
  wa_msg_delivery: 'Hello {contact}, delivery for {store} on {delivery_date}:\n{delivered_summary}\nReturns collected: {returned_summary}\nThank you! – Prosa',
  wa_link_delivery: '',
}
const KEYS = Object.keys(WA_DEFAULTS)

// Cached in memory so the WhatsApp tap can open instantly (phones block
// windows opened after waiting on the network).
let cache = { ...WA_DEFAULTS }
let loaded = false
// Throws if your saved messages couldn't be read (so Settings never shows the defaults
// as if they were yours, and a later Save can't overwrite your real messages).
export async function loadWaTemplates() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data, error } = await supabase.from('user_settings').select(KEYS.join(', ')).eq('user_id', user.id).maybeSingle()
  if (error) throw error
  cache = Object.fromEntries(KEYS.map(k => [k, data?.[k] ?? WA_DEFAULTS[k]]))
  loaded = true
  return cache
}
export const waTemplatesLoaded = () => loaded

// App start: keep retrying until the messages are loaded (weak signal, app opened offline).
// Retries after 5s, 15s, 30s, then every minute; also when the phone comes back online
// or the app is reopened.
export function startWaTemplateLoader() {
  let timer = null, tries = 0, stopped = false
  const attempt = async () => {
    clearTimeout(timer)
    if (stopped || loaded) return
    try { await loadWaTemplates() } catch {
      tries++
      timer = setTimeout(attempt, [5000, 15000, 30000][tries - 1] ?? 60000)
    }
  }
  const onWake = () => { if (!loaded && document.visibilityState !== 'hidden') attempt() }
  window.addEventListener('online', onWake)
  document.addEventListener('visibilitychange', onWake)
  attempt()
  return () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', onWake); document.removeEventListener('visibilitychange', onWake) }
}
export function setWaTemplates(patch) { cache = { ...cache, ...patch } }
export function getWaTemplates() { return cache }

export function waGroup(status) {
  if (status === 'prospect') return 'prospect'
  if (['warm', 'cold', 'dormant', 'dropped'].includes(status)) return 'followup'
  return 'store'
}

// ---- Placeholders ---------------------------------------------------------
// Shown in Settings as the reference list + insert chips.
export const PLACEHOLDERS = [
  ['{store}', 'Store name', 'Grand Fresh Aluva'],
  ['{contact}', 'Person you picked, with Mr./Mrs./Miss (falls back to the store name for a store phone)', 'Mr. Rajesh'],
  ['{contact_title}', "That person's title (blank for a store phone)", 'Purchase Manager'],
  ['{greeting}', 'Good morning / afternoon / evening, by time of day', 'Good morning'],
  ['{today}', "Today's day and date", 'Thursday, 24 Sep'],
  ['{tomorrow}', "Tomorrow's day and date", 'Friday, 25 Sep'],
  ['{last_visit}', 'Date of the last delivery to this store', '18 Sep'],
  ['{days_since_visit}', 'Days since the last delivery', '6'],
  ['{last_qty}', 'Packs delivered on the last visit', '12'],
  ['{last_call}', 'Remark from your most recent logged call', 'Manager asked for samples'],
  ['{followup_date}', "The store's next open follow-up date", '28 Sep'],
  // Delivery message only — filled from the delivery just recorded
  ['{delivery_date}', 'Delivery message only: date of this delivery', '24 Sep'],
  ['{delivered_summary}', 'Delivery message only: items delivered', 'Idli/Dosa Batter × 12, Chappathi × 6'],
  ['{delivered_qty}', 'Delivery message only: total packs delivered', '18'],
  ['{returned_summary}', 'Delivery message only: returns collected (line is dropped if there were none)', 'Idli/Dosa Batter × 2'],
  ['{returned_qty}', 'Delivery message only: total packs returned', '2'],
  ['{bill_amount}', 'Delivery message only: (delivered − returned) × price', '₹1,120'],
]

const fmtDay = (d, withWeekday) => d.toLocaleDateString('en-GB', withWeekday ? { weekday: 'long', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })
const ymdToDate = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d) }
const localYMD = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Per-store facts, loaded once in the background (and refreshed after calls/deliveries)
let storeCtx = {}
let storeStatus = {} // store id → pipeline status, for picking the message group
export async function loadWaContext() {
  const since = new Date(); since.setDate(since.getDate() - 120)
  // Paged, so every store is covered (a single request stops at 1000 rows)
  const [lines, logs, stores] = await Promise.all([
    fetchAll(() => supabase.from('delivery_lines').select('id, store_id, delivered_on, qty_delivered')
      .gt('qty_delivered', 0).gte('delivered_on', localYMD(since)).order('delivered_on', { ascending: false }).order('id')),
    fetchAll(() => supabase.from('call_logs').select('id, store_id, kind, note, follow_up_on, called_at')
      .not('store_id', 'is', null).order('called_at', { ascending: false }).order('id')),
    fetchAll(() => supabase.from('stores').select('id, pipeline_status').order('id')),
  ])
  storeStatus = Object.fromEntries(stores.map(s => [s.id, s.pipeline_status]))
  const ctx = {}
  const get = id => (ctx[id] = ctx[id] || {})
  ;(lines || []).forEach(l => {
    const c = get(l.store_id)
    if (!c.last_visit) c.last_visit = l.delivered_on
    if (l.delivered_on === c.last_visit) c.last_qty = (c.last_qty || 0) + l.qty_delivered
  })
  // latest call remark; earliest follow-up still open (open until a newer call)
  const lastCallAt = {}
  ;(logs || []).forEach(l => {
    const kind = l.kind || 'call'
    if (kind === 'call' && !lastCallAt[l.store_id]) { lastCallAt[l.store_id] = l.called_at; if (l.note) get(l.store_id).last_call = l.note.split('\n').filter(x => !x.startsWith('Status:')).join(' ').trim() }
  })
  const today = localYMD()
  ;(logs || []).forEach(l => {
    if (!l.follow_up_on || (l.kind || 'call') === 'visit' || l.follow_up_on < today) return
    if (lastCallAt[l.store_id] && l.called_at < lastCallAt[l.store_id]) return
    const c = get(l.store_id)
    if (!c.followup_date || l.follow_up_on < c.followup_date) c.followup_date = l.follow_up_on
  })
  storeCtx = ctx
  return ctx
}

function fillPlaceholders(text, storeName, storeId, contactName, contactTitle, delivery) {
  const now = new Date()
  const h = now.getHours()
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1)
  const c = storeCtx[storeId] || {}
  const days = c.last_visit ? Math.round((ymdToDate(localYMD()) - ymdToDate(c.last_visit)) / 86400000) : null
  const values = {
    store: storeName || '',
    contact: contactName || storeName || '',
    contact_title: contactName ? (contactTitle || '') : '',
    greeting: h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening',
    today: fmtDay(now, true),
    tomorrow: fmtDay(tmr, true),
    last_visit: c.last_visit ? fmtDay(ymdToDate(c.last_visit)) : '',
    days_since_visit: days == null ? '' : String(days),
    last_qty: c.last_qty ? String(c.last_qty) : '',
    last_call: c.last_call || '',
    followup_date: c.followup_date ? fmtDay(ymdToDate(c.followup_date)) : '',
    ...deliveryValues(delivery),
  }
  // A line whose placeholders ALL come out empty is dropped entirely
  // (e.g. "Returns collected: {returned_summary}" when nothing came back).
  // Otherwise empty placeholders become blank and the leftover spaces are tidied.
  return text.split('\n').filter(line => {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(k => k in values)
    return keys.length === 0 || keys.some(k => values[k])
  }).map(line => line.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m))
    .replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1')).join('\n')
}

// delivery = { date: 'YYYY-MM-DD', items: [{ name, delivered, returned, price }] }
const DELIVERY_KEYS = ['delivery_date', 'delivered_summary', 'delivered_qty', 'returned_summary', 'returned_qty', 'bill_amount']
function deliveryValues(d) {
  // outside the delivery message these placeholders are simply blank
  if (!d) return Object.fromEntries(DELIVERY_KEYS.map(k => [k, '']))
  const items = d.items || []
  const list = key => items.filter(i => i[key] > 0).map(i => `${i.name} × ${i[key]}`).join(', ')
  const sum = key => items.reduce((n, i) => n + (Number(i[key]) || 0), 0)
  const amount = items.reduce((n, i) => n + ((Number(i.delivered) || 0) - (Number(i.returned) || 0)) * (Number(i.price) || 0), 0)
  return {
    delivery_date: d.date ? fmtDay(ymdToDate(d.date)) : '',
    delivered_summary: list('delivered'),
    delivered_qty: sum('delivered') ? String(sum('delivered')) : '',
    returned_summary: list('returned'),
    returned_qty: sum('returned') ? String(sum('returned')) : '',
    bill_amount: amount > 0 ? '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '',
  }
}

// Delivery confirmation message for one contact
export function buildDeliveryText(storeName, storeId, contactName, contactTitle, delivery) {
  const tpl = cache.wa_msg_delivery || ''
  const link = (cache.wa_link_delivery || '').trim()
  return [fillPlaceholders(tpl, storeName, storeId, contactName, contactTitle, delivery).trim(), link].filter(Boolean).join('\n\n')
}

export function setStoreStatus(storeId, status) { if (storeId) storeStatus[storeId] = status }

export function buildWaText(status, storeName, storeId, contactName, contactTitle) {
  // A screen may not have the store's status yet (still loading) — use the one loaded at app start
  const g = waGroup(status || storeStatus[storeId])
  const tpl = cache[`wa_msg_${g}`] || ''
  const link = (cache[`wa_link_${g}`] || '').trim()
  // Link goes on its own line at the end — WhatsApp shows it as a preview card
  return [fillPlaceholders(tpl, storeName, storeId, contactName, contactTitle).trim(), link].filter(Boolean).join('\n\n')
}
