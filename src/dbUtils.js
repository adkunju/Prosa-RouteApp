// Supabase returns at most 1000 rows per request. For queries over full history
// (stock usage, monthly sales), page through with .range() until everything is read.
// makeQuery must build a FRESH query each call, e.g. () => supabase.from('x').select('a').order('id')
export async function fetchAll(makeQuery, page = 1000) {
  const all = []
  for (let from = 0; ; from += page) {
    const { data, error } = await makeQuery().range(from, from + page - 1)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < page) break
  }
  return all
}

// Local (IST) calendar date as YYYY-MM-DD — toISOString() gives the UTC date, which is
// yesterday between midnight and 5:30am.
export const localISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Whole days from today until a YYYY-MM-DD date (negative = past), by calendar date.
export function daysUntilDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(); const today = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return Math.round((new Date(y, m - 1, d) - today) / 86400000)
}

// 86 → "1 hr 26 mins", 45 → "45 mins", 120 → "2 hrs"
export function formatDuration(mins) {
  const total = Math.max(0, Math.round(mins || 0))
  const h = Math.floor(total / 60), m = total % 60
  const hs = h ? `${h} ${h === 1 ? 'hr' : 'hrs'}` : ''
  const ms = m || !h ? `${m} ${m === 1 ? 'min' : 'mins'}` : ''
  return [hs, ms].filter(Boolean).join(' ')
}
