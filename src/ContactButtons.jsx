import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'
import { Phone, MessageCircle, Star, X } from 'lucide-react'
import { markCallStarted } from './CallFollowupPrompt'
import { buildWaText } from './waTemplates'
import { personName, contactLabel } from './contactUtils'

const cleanNum = p => String(p || '').replace(/[^\d+]/g, '')

// One fetch per screen: store_id -> contacts [{id, name, phone, is_primary}], main contact first.
// Refreshes when contacts change anywhere in the app.
export function useStoreContacts() {
  const [map, setMap] = useState({})
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('store_contacts').select('id, store_id, salutation, name, title, phone, is_primary, created_at')
        .order('is_primary', { ascending: false }).order('created_at')
      const m = {}
      ;(data || []).forEach(c => { (m[c.store_id] = m[c.store_id] || []).push(c) })
      setMap(m)
    }
    load()
    window.addEventListener('prosa:contacts_changed', load)
    return () => window.removeEventListener('prosa:contacts_changed', load)
  }, [])
  return map
}

// Open WhatsApp / start a call to one specific contact
export function openWhatsApp(contact, { status, storeName, storeId }) {
  const text = buildWaText(status, storeName, storeId, personName(contact), contact.title || '')
  window.open(`https://wa.me/${cleanNum(contact.phone).replace('+', '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`, '_blank')
}
export function startCall(contact, { storeName, storeId }) {
  if (storeId) markCallStarted({ storeId, name: storeName, phone: cleanNum(contact.phone), contactId: contact.id || null, contactName: contact.id ? contactLabel(contact) : '' })
  window.location.href = `tel:${cleanNum(contact.phone)}`
}

// `phone` may be a single number (old callers) or the contacts array from useStoreContacts.
// With several contacts, tapping asks who to reach. variant "pill": larger round buttons.
export default function ContactButtons({ phone, size = 13, storeId, storeName, variant, status }) {
  const [picking, setPicking] = useState(null) // 'call' | 'wa'
  const contacts = Array.isArray(phone) ? phone : phone ? [{ id: null, name: null, phone }] : []
  if (contacts.length === 0) return null
  const ctx = { status, storeName, storeId }
  const act = (kind, c) => { setPicking(null); kind === 'wa' ? openWhatsApp(c, ctx) : startCall(c, ctx) }
  const tap = kind => e => { e.stopPropagation(); contacts.length === 1 ? act(kind, contacts[0]) : setPicking(kind) }

  const pill = variant === 'pill'
  const base = pill
    ? 'w-9 h-9 rounded-full bg-[var(--bg-input)] flex items-center justify-center transition-colors'
    : 'text-[var(--text-muted2)] p-1.5 rounded-lg transition-colors'
  return (
    <span className={`flex items-center shrink-0 ${pill ? 'gap-2' : 'gap-1'}`}>
      <button onClick={tap('wa')} title="WhatsApp" aria-label="WhatsApp"
        className={`${base} ${pill ? 'text-emerald-500 hover:bg-emerald-500/15' : 'hover:text-[var(--accent)]'}`}>
        <MessageCircle size={pill ? 17 : size} />
      </button>
      <button onClick={tap('call')} title="Call" aria-label="Call"
        className={`${base} ${pill ? 'text-[var(--accent)] hover:bg-[var(--accent)]/15' : 'hover:text-[var(--text-accent)]'}`}>
        <Phone size={pill ? 17 : size} />
      </button>
      {picking && createPortal(
        <div className="fixed inset-0 z-[75] bg-black/60 flex items-center justify-center p-4" onClick={e => { e.stopPropagation(); setPicking(null) }}>
          <div className="bg-[var(--bg-card)] rounded-2xl w-full max-w-sm p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="text-[var(--text-primary)] font-semibold">{picking === 'wa' ? 'WhatsApp who?' : 'Call who?'}</div>
                <div className="text-[var(--text-muted2)] text-xs">{storeName}</div>
              </div>
              <button onClick={() => setPicking(null)} className="text-[var(--text-muted)]"><X size={20} /></button>
            </div>
            <div className="flex flex-col gap-2">
              {contacts.map((c, i) => (
                <button key={c.id || i} onClick={() => act(picking, c)}
                  className="w-full text-left bg-[var(--bg-input)]/50 hover:bg-[var(--bg-input)] rounded-xl px-3 py-3 flex items-center gap-3">
                  <span className={picking === 'wa' ? 'text-emerald-500' : 'text-[var(--accent)]'}>
                    {picking === 'wa' ? <MessageCircle size={18} /> : <Phone size={18} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-[var(--text-primary)] truncate">
                      {contactLabel(c)} {c.is_primary && <Star size={11} className="inline text-[var(--text-gold)] fill-current -mt-0.5" />}
                    </span>
                    <span className="block text-xs text-[var(--text-muted2)]">{c.phone}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </span>
  )
}
