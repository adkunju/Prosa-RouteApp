import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Phone, MessageCircle } from 'lucide-react'

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

export default function ContactButtons({ phone, size = 13 }) {
  if (!phone) return null
  const clean = String(phone).replace(/[^\d+]/g, '')
  return (
    <span className="flex items-center gap-1 shrink-0">
      <button
        onClick={e => { e.stopPropagation(); window.open(`https://wa.me/${clean.replace('+', '')}`, '_blank') }}
        className="text-[var(--text-muted2)] hover:text-[var(--accent)] p-1.5 rounded-lg transition-colors"
        title="WhatsApp">
        <MessageCircle size={size} />
      </button>
      <button
        onClick={e => { e.stopPropagation(); window.location.href = `tel:${clean}` }}
        className="text-[var(--text-muted2)] hover:text-[var(--text-accent)] p-1.5 rounded-lg transition-colors"
        title="Call">
        <Phone size={size} />
      </button>
    </span>
  )
}
