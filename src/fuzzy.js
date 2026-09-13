export function normalize(s) {
  return (s || '').toLowerCase().replace(/[\s\-,.]/g, '')
}

export function fuzzyMatch(query, target) {
  const q = normalize(query)
  const t = normalize(target)
  if (!q) return true
  if (t.includes(q)) return true
  // subsequence fallback: characters of q must appear in order in t
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}
