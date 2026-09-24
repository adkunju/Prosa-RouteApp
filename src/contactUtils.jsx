import { useState } from 'react'
import { supabase } from './supabaseClient'

export const SALUTATIONS = ['Mr.', 'Mrs.', 'Miss']
export const TITLE_SUGGESTIONS = ['Purchase Manager', 'Store Manager', 'Owner', 'Floor Manager', 'Accounts', 'Store Phone']

// "Mr. Rajesh" — empty when the contact has no personal name (e.g. a store landline)
export const personName = c => (c?.name ? [c.salutation, c.name].filter(Boolean).join(' ') : '')

// "Mr. Rajesh · Purchase Manager", or just "Store Phone" for a general number
export const contactLabel = c => {
  const p = personName(c)
  if (p && c.title) return `${p} · ${c.title}`
  return p || c?.title || 'Contact'
}

// Inline form to add a contact to a store. Calls onAdded(newContact) after saving.
export function AddContactForm({ storeId, onAdded, onCancel, compact = false }) {
  const [salutation, setSalutation] = useState('Mr.')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 8) return setError('Enter a valid phone number')
    setSaving(true); setError('')
    const { data, error: e } = await supabase.from('store_contacts').insert({
      store_id: storeId,
      salutation: name.trim() ? salutation : null,
      name: name.trim() || null,
      title: title.trim() || null,
      phone: phone.trim(),
    }).select('*').single()
    setSaving(false)
    if (e) return setError('Could not save: ' + e.message)
    window.dispatchEvent(new CustomEvent('prosa:contacts_changed'))
    setName(''); setTitle(''); setPhone('')
    onAdded?.(data)
  }

  const field = 'bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] min-w-0'
  return (
    <div className={`flex flex-col gap-2 ${compact ? '' : 'bg-[var(--bg-input)]/30 rounded-xl p-3'}`}>
      <div className="flex gap-2">
        <select value={salutation} onChange={e => setSalutation(e.target.value)} className={field + ' w-20 shrink-0'}>
          {SALUTATIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. Rajesh)" className={field + ' flex-1'} />
      </div>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (e.g. Purchase Manager)" list="contact-titles" className={field} />
      <datalist id="contact-titles">{TITLE_SUGGESTIONS.map(t => <option key={t} value={t} />)}</datalist>
      <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" className={field} />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex gap-2 justify-end">
        {onCancel && <button type="button" onClick={onCancel} className="text-sm text-[var(--text-muted2)] px-3">Cancel</button>}
        <button type="button" onClick={save} disabled={saving}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white text-sm font-semibold rounded-lg px-4 py-2">
          {saving ? 'Saving...' : 'Add contact'}
        </button>
      </div>
    </div>
  )
}
