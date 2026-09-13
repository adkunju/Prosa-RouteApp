import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Plus, X, CheckCircle, Trash2, ChevronDown, Pencil } from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)
function emptyLine(id) {
  return { id, sku_id: '', type: 'sale', produced_on: '', qty: '' }
}

export default function LogScreen() {
  const [stores, setStores] = useState([])
  const [skus, setSkus] = useState([])
  const [batches, setBatches] = useState([])
  const [recentVisits, setRecentVisits] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [store_id, setStoreId] = useState('')
  const [date, setDate] = useState(today())
  const [lines, setLines] = useState([emptyLine(1)])
  const [nextId, setNextId] = useState(2)
  const [deleting, setDeleting] = useState(null)

  async function load() {
    const [{ data: st }, { data: sk }, { data: ba }, { data: rv }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('is_active', true).eq('is_depot', false).order('name'),
      supabase.from('skus').select('id, name').eq('is_active', true).order('name'),
      supabase.from('production_batches').select('id, sku_id, produced_on, expires_on, qty').gt('expires_on', today()).order('expires_on'),
      supabase.from('delivery_lines')
        .select('id, delivered_on, qty_delivered, sku_id, plan_stop_id, skus(name), plan_stops(store_id, stores(name)), returns(id, qty_returned), production_batches(produced_on)')
        .order('delivered_on', { ascending: false }).limit(40),
    ])
    if (st) setStores(st)
    if (sk) setSkus(sk)
    if (ba) setBatches(ba)
    if (rv) setRecentVisits(rv)
  }

  useEffect(() => { load() }, [])

  function addLine() { setLines(l => [...l, emptyLine(nextId)]); setNextId(n => n + 1) }
  function removeLine(id) { setLines(l => l.filter(x => x.id !== id)) }
  function setLineField(id, field, value) {
    setLines(l => l.map(x => x.id === id ? { ...x, [field]: value } : x))
  }
  function batchesForSku(sku_id) { return batches.filter(b => b.sku_id === sku_id) }

  function lineValid(line) {
    if (!line.sku_id || !line.qty || !line.produced_on) return false
    return true
  }
  function formValid() { return store_id && lines.every(lineValid) }

  function resetForm() {
    setShowForm(false); setStoreId(''); setDate(today())
    setLines([emptyLine(1)]); setNextId(2)
  }

  async function deleteVisit(deliveryLineId, returnIds) {
    setDeleting(deliveryLineId)
    for (const rid of returnIds) {
      await supabase.from('returns').delete().eq('id', rid)
    }
    await supabase.from('delivery_lines').delete().eq('id', deliveryLineId)
    await load()
    setDeleting(null)
  }

  async function saveVisit() {
    if (!formValid()) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()

    let planId
    const { data: ep } = await supabase.from('plans').select('id').eq('user_id', user.id).eq('plan_date', date).maybeSingle()
    if (ep) { planId = ep.id } else {
      const { data: np } = await supabase.from('plans').insert({ user_id: user.id, plan_date: date, status: 'completed' }).select('id').single()
      planId = np?.id
    }
    if (!planId) { setSaving(false); return }

    const { count } = await supabase.from('plan_stops').select('id', { count: 'exact', head: true }).eq('plan_id', planId)
    const { data: stop } = await supabase.from('plan_stops')
      .insert({ plan_id: planId, store_id, stop_order: (count || 0) + 1 })
      .select('id').single()
    if (!stop) { setSaving(false); return }

    for (const line of lines) {
      const batch = batchesForSku(line.sku_id).find(b => b.produced_on === line.produced_on)
      if (line.type === 'sale') {
        await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: Number(line.qty), delivered_on: date,
        })
      } else {
        const { data: dl } = await supabase.from('delivery_lines').insert({
          plan_stop_id: stop.id, sku_id: line.sku_id,
          batch_id: batch?.id || null,
          qty_delivered: 0, delivered_on: date,
        }).select('id').single()
        if (dl) await supabase.from('returns').insert({
          delivery_line_id: dl.id, qty_returned: Number(line.qty),
          returned_on: date, possible_stockout: false,
        })
      }
    }

    await load(); setSaving(false); setSaved(true)
    setTimeout(() => { setSaved(false); resetForm() }, 1200)
  }

  const grouped = recentVisits.reduce((acc, v) => {
    const d = v.delivered_on; if (!acc[d]) acc[d] = []; acc[d].push(v); return acc
  }, {})

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
        <span className="text-[var(--text-muted)] text-sm">Delivery log</span>
        <button onClick={() => setShowForm(true)}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors">
          <Plus size={15} /> Log visit
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-4">
        {Object.keys(grouped).length === 0 && (
          <div className="text-center text-[var(--text-muted2)] mt-16">
            <CheckCircle size={40} className="mx-auto mb-3 opacity-40" />
            <p>No deliveries logged yet</p>
          </div>
        )}
        {Object.entries(grouped).sort(([a],[b]) => b.localeCompare(a)).map(([d, lines]) => (
          <div key={d}>
            <div className="text-[var(--text-muted2)] text-xs font-medium mb-2 uppercase tracking-wide">{d}</div>
            <div className="flex flex-col gap-2">
              {lines.map(line => (
                <div key={line.id} className="bg-[var(--bg-card)] rounded-xl px-4 py-3 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[var(--text-primary)] text-sm font-medium truncate">{line.plan_stops?.stores?.name}</div>
                    <div className="text-[var(--text-muted)] text-xs mt-0.5">
                      {line.skus?.name}
                      {line.qty_delivered > 0 && ` · ${line.qty_delivered} sold`}
                      {line.returns?.length > 0 && ` · ${line.returns[0].qty_returned} returned`}
                      {line.production_batches?.produced_on && (
                        <span className="text-[var(--text-muted2)]"> · batch {line.production_batches.produced_on}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteVisit(line.id, line.returns?.map(r => r.id) || [])}
                    disabled={deleting === line.id}
                    className="text-[var(--text-faint)] hover:text-red-400 transition-colors shrink-0 mt-0.5"
                  >
                    {deleting === line.id ? '...' : <Trash2 size={15} />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="absolute inset-0 bg-[var(--bg-root)] flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center justify-between shrink-0">
            <h2 className="text-[var(--text-primary)] font-semibold">Log Visit</h2>
            <button onClick={resetForm} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={20} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-3">
            <div className="relative">
              <select value={store_id} onChange={e => setStoreId(e.target.value)}
                className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none">
                <option value="">Select store...</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <ChevronDown size={16} className="absolute right-3 top-3.5 text-[var(--text-muted)] pointer-events-none" />
            </div>

            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />

            <div className="flex flex-col gap-3 mt-1">
              {lines.map(line => (
                <div key={line.id} className="bg-[var(--bg-card)] rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-muted)] text-xs font-medium uppercase tracking-wide">Item</span>
                    {lines.length > 1 && (
                      <button onClick={() => removeLine(line.id)} className="text-[var(--text-muted2)] hover:text-red-400 transition-colors">
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>

                  <div className="relative">
                    <select value={line.sku_id} onChange={e => setLineField(line.id, 'sku_id', e.target.value)}
                      className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none">
                      <option value="">Select product...</option>
                      {skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                  </div>

                  <div className="flex rounded-lg overflow-hidden border border-[var(--bg-hover)]">
                    <button onClick={() => setLineField(line.id, 'type', 'sale')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${line.type === 'sale' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                      Sale
                    </button>
                    <button onClick={() => setLineField(line.id, 'type', 'return')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${line.type === 'return' ? 'bg-[var(--text-amber)] text-white' : 'text-[var(--text-muted)] hover:text-white'}`}>
                      Return
                    </button>
                  </div>

                  {/* Production date — dropdown for sale, manual entry for return */}
                  <div>
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Production date *</label>
                    {line.type === 'sale' ? (
                      <>
                        <div className="relative">
                          <select value={line.produced_on} onChange={e => setLineField(line.id, 'produced_on', e.target.value)}
                            disabled={!line.sku_id}
                            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] appearance-none disabled:opacity-50">
                            <option value="">Select batch...</option>
                            {batchesForSku(line.sku_id).map(b => (
                              <option key={b.id} value={b.produced_on}>
                                {b.produced_on} · expires {b.expires_on} · {b.qty} pcs
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={15} className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none" />
                        </div>
                        {line.sku_id && batchesForSku(line.sku_id).length === 0 && (
                          <p className="text-[var(--text-gold)] text-xs mt-1">⚠ No active batches — log production first</p>
                        )}
                      </>
                    ) : (
                      <input type="date" value={line.produced_on}
                        onChange={e => setLineField(line.id, 'produced_on', e.target.value)}
                        className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                        placeholder="Date stock was produced" />
                    )}
                  </div>

                  <div>
                    <label className="text-[var(--text-muted)] text-xs mb-1 block">Quantity</label>
                    <input type="number" placeholder="0" value={line.qty}
                      onChange={e => setLineField(line.id, 'qty', e.target.value)}
                      className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addLine}
              className="flex items-center gap-2 text-[var(--text-accent)] hover:text-[var(--text-accent2)] text-sm font-medium py-2 transition-colors">
              <Plus size={16} /> Add item
            </button>
          </div>

          <div className="p-4 border-t border-[var(--bg-input)] shrink-0">
            <button onClick={saveVisit} disabled={!formValid() || saving || saved}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2">
              {saved ? <><CheckCircle size={18} /> Saved!</> : saving ? 'Saving...' : 'Save Visit'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
