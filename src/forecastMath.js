// Approximation of the inverse normal CDF (Acklam's algorithm)
export function probit(p) {
  if (p <= 0) return -4
  if (p >= 1) return 4
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pLow = 0.02425, pHigh = 1 - pLow
  let q, r
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  } else if (p <= pHigh) {
    q = p - 0.5; r = q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
}

export function computeProposedQty(row) {
  const { avg_daily_rate, rate_stddev, avg_gap_days, unit_cost, unit_price } = row
  const days = avg_gap_days || 1
  const price = Number(unit_price) || 0
  const cost = Number(unit_cost) || 0
  const margin = price - cost
  const criticalRatio = price > 0 ? Math.max(0.05, Math.min(0.95, margin / price)) : 0.5
  const z = probit(criticalRatio)
  const rate = Number(avg_daily_rate) || 0
  const sigma = Number(rate_stddev) || 0
  const qty = rate * days + z * sigma * Math.sqrt(days)
  let proposed = Math.max(0, Math.ceil(qty))
  // Sold out (nothing returned) on 2 of the last 3 visits: the store may sell more than it
  // has been given, so try one extra pack. Not for depot pickups (Moolans) — their returns
  // aren't recorded, so "sold out" can't be told apart from "no returns logged".
  const soldOutBoost = proposed > 0 && !row.is_pickup && Number(row.recent_soldouts) >= 2
  if (soldOutBoost) proposed += 1
  return { proposed, soldOutBoost, z: z.toFixed(2), criticalRatio: (criticalRatio * 100).toFixed(0) }
}

export function bearingFromDepot(depotLat, depotLng, lat, lng) {
  const toRad = d => d * Math.PI / 180
  const toDeg = r => r * 180 / Math.PI
  const dLng = toRad(lng - depotLng)
  const y = Math.sin(dLng) * Math.cos(toRad(lat))
  const x = Math.cos(toRad(depotLat)) * Math.sin(toRad(lat)) - Math.sin(toRad(depotLat)) * Math.cos(toRad(lat)) * Math.cos(dLng)
  const brng = toDeg(Math.atan2(y, x))
  return (brng + 360) % 360
}
