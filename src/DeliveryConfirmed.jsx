import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { buildDeliveryText } from './waTemplates'
import { contactLabel, personName, AddContactForm } from './contactUtils'
import { CheckCircle2, MessageCircle, Truck } from 'lucide-react'

const pickDefault = cs => cs.find(c => c.is_delivery) || cs.find(c => c.is_primary) || cs[0] || null
const fmtDate = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) }

// Shown after a delivery is recorded. items: [{ name, delivered, returned, price }]
// "Send on WhatsApp" goes to the store's D (delivery) contact, else main, else first.
export default function DeliveryConfirmed({ storeId, storeName, date, items, onClose }) {
  const [contacts, setContacts] = useState(null)
  const [chosenId, setChosenId] = useState('')
  const [adding, setAdding] = useState(false)

  async function load(selectId) {
    const { data } = await supabase.from('store_contacts')
      .select('id, salutation, name, title, phone, is_primary, is_delivery')
      .eq('store_id', storeId).order('is_delivery', { ascending: false }).order('is_primary', { ascending: false }).order('created_at')
    setContacts(data || [])
    setChosenId(selectId || pickDefault(data || [])?.id || '')
  }
  useEffect(() => { load() }, [storeId])

  const chosen = (contacts || []).find(c => c.id === chosenId)
  const delivered = items.filter(i => i.delivered > 0)
  const returned = items.filter(i => i.returned > 0)
  const amount = items.reduce((n, i) => n + ((+i.delivered || 0) - (+i.returned || 0)) * (+i.price || 0), 0)

  function send() {
    if (!chosen) return
    const text = buildDeliveryText(storeName, storeId, personName(chosen), chosen.title || '', { date, items })
    window.open(`https://wa.me/${String(chosen.phone).replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}`, '_blank')
  }
  async function makeDeliveryContact() {
    await supabase.from('store_contacts').update({ is_delivery: false }).eq('store_id', storeId).eq('is_delivery', true)
    await supabase.from('store_contacts').update({ is_delivery: true }).eq('id', chosenId)
    window.dispatchEvent(new CustomEvent('prosa:contacts_changed'))
    load(chosenId)
  }

  return createPortal(
    <div className="fixed inset-0 z-[85] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-4">
          <CheckCircle2 size={44} className="text-[var(--accent)] mb-2" />
          <div className="text-[var(--text-primary)] text-lg font-semibold">Delivery confirmed</div>
          <div className="text-[var(--text-muted2)] text-sm">{storeName} · {fmtDate(date)}</div>
        </div>

        <div className="bg-[var(--bg-input)]/40 rounded-xl p-3 text-sm flex flex-col gap-1 mb-4">
          {delivered.map(i => (
            <div key={'d' + i.name} className="flex justify-between"><span className="text-[var(--text-secondary)] flex items-center gap-1.5"><Truck size={13} /> {i.name}</span><span className="text-[var(--text-primary)] font-medium">{i.delivered}</span></div>
          ))}
          {returned.map(i => (
            <div key={'r' + i.name} className="flex justify-between text-[var(--text-amber)]"><span>↩ {i.name} returned</span><span>{i.returned}</span></div>
          ))}
          {delivered.length === 0 && returned.length === 0 && <div className="text-[var(--text-muted2)]">Visit recorded</div>}
          {amount > 0 && (
            <div className="flex justify-between border-t border-[var(--bg-input)]/60 pt-1 mt-1"><span className="text-[var(--text-muted)]">Bill</span><span className="text-[var(--text-primary)] font-semibold">₹{amount.toLocaleString('en-IN')}</span></div>
          )}
        </div>

        {contacts === null ? null : adding || contacts.length === 0 ? (
          <div className="mb-3">
            <div className="text-[var(--text-muted)] text-xs mb-2">{contacts.length === 0 ? 'No contact saved for this store — add one to send the delivery message:' : 'Add a contact'}</div>
            <AddContactForm storeId={storeId} onCancel={contacts.length ? () => setAdding(false) : undefined}
              onAdded={c => { setAdding(false); load(c.id) }} />
          </div>
        ) : (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <label className="text-[var(--text-muted)] text-xs">Send to</label>
              <button onClick={() => setAdding(true)} className="text-[var(--accent)] text-xs font-medium">+ Add contact</button>
            </div>
            <select value={chosenId} onChange={e => setChosenId(e.target.value)}
              className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]">
              {contacts.map(c => <option key={c.id} value={c.id}>{c.is_delivery ? '[D] ' : ''}{contactLabel(c)}{c.is_primary ? ' ★' : ''} · {c.phone}</option>)}
            </select>
            {chosen && !chosen.is_delivery && (
              <button onClick={makeDeliveryContact} className="text-[11px] text-[var(--text-muted2)] hover:text-[var(--accent)] mt-1">
                Always send delivery messages to this contact (set as D)
              </button>
            )}
          </div>
        )}

        <button onClick={send} disabled={!chosen}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 mb-2">
          <MessageCircle size={18} /> Send on WhatsApp
        </button>
        <button onClick={onClose} className="w-full text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm py-2">Done</button>
      </div>
    </div>,
    document.body
  )
}
