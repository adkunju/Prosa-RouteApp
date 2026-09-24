import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Phone, MessageCircle } from 'lucide-react'
import { markCallStarted } from './CallFollowupPrompt'

// One fetch per screen: store_id -> first phone number.
export function useStoreContacts() {
  const [phones, setPhones] = useState({})
  useEffect(() => { (async () => {
    const { data } = await supabase.from('store_contacts').select('store_id, phone')
    const map = {}
    ;(data || []).forEach(c => { if (!map[c.store_id]) map[c.store_id] = c.phone })
    setPhones(map)
  })() }, [])
  return phones
}

// variant "pill": larger round buttons (easier to tap on a phone), used on the Sales cards
export default function ContactButtons({ phone, size = 13, storeId, storeName, variant }) {
  if (!phone) return null
  const clean = String(phone).replace(/[^\d+]/g, '')
  const pill = variant === 'pill'
  const base = pill
    ? 'w-9 h-9 rounded-full bg-[var(--bg-input)] flex items-center justify-center transition-colors'
    : 'text-[var(--text-muted2)] p-1.5 rounded-lg transition-colors'
  return (
    <span className={`flex items-center shrink-0 ${pill ? 'gap-2' : 'gap-1'}`}>
      <button
        onClick={e => { e.stopPropagation(); window.open(`https://wa.me/${clean.replace('+', '')}`, '_blank') }}
        className={`${base} ${pill ? 'text-emerald-500 hover:bg-emerald-500/15' : 'hover:text-[var(--accent)]'}`}
        title="WhatsApp" aria-label="WhatsApp">
        <MessageCircle size={pill ? 17 : size} />
      </button>
      <button
        onClick={e => { e.stopPropagation(); if (storeId) markCallStarted({ storeId, name: storeName, phone: clean }); window.location.href = `tel:${clean}` }}
        className={`${base} ${pill ? 'text-[var(--accent)] hover:bg-[var(--accent)]/15' : 'hover:text-[var(--text-accent)]'}`}
        title="Call" aria-label="Call">
        <Phone size={pill ? 17 : size} />
      </button>
    </span>
  )
}
