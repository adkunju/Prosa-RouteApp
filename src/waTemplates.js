import { supabase } from './supabaseClient'

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
}
const KEYS = Object.keys(WA_DEFAULTS)

// Cached in memory so the WhatsApp tap can open instantly (phones block
// windows opened after waiting on the network).
let cache = { ...WA_DEFAULTS }
export async function loadWaTemplates() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return cache
  const { data } = await supabase.from('user_settings').select(KEYS.join(', ')).eq('user_id', user.id).maybeSingle()
  cache = Object.fromEntries(KEYS.map(k => [k, data?.[k] ?? WA_DEFAULTS[k]]))
  return cache
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
]

const fmtDay = (d, withWeekday) => d.toLocaleDateString('en-GB', withWeekday ? { weekday: 'long', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })
const ymdToDate = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d) }
const localYMD = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Per-store facts, loaded once in the background (and refreshed after calls/deliveries)
let storeCtx = {}
export async function loadWaContext() {
  const since = new Date(); since.setDate(since.getDate() - 120)
  const [{ data: lines }, { data: logs }] = await Promise.all([
    supabase.from('delivery_lines').select('store_id, delivered_on, qty_delivered')
      .gt('qty_delivered', 0).gte('delivered_on', localYMD(since)).order('delivered_on', { ascending: false }).limit(1000),
    supabase.from('call_logs').select('store_id, kind, note, follow_up_on, called_at')
      .not('store_id', 'is', null).order('called_at', { ascending: false }).limit(2000),
  ])
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

function fillPlaceholders(text, storeName, storeId, contactName, contactTitle) {
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
  }
  // Unknown or empty placeholders become blank; tidy the spaces they leave behind
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m))
    .replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1')
}

export function buildWaText(status, storeName, storeId, contactName, contactTitle) {
  const g = waGroup(status)
  const tpl = cache[`wa_msg_${g}`] || ''
  const link = (cache[`wa_link_${g}`] || '').trim()
  // Link goes on its own line at the end — WhatsApp shows it as a preview card
  return [fillPlaceholders(tpl, storeName, storeId, contactName, contactTitle).trim(), link].filter(Boolean).join('\n\n')
}
