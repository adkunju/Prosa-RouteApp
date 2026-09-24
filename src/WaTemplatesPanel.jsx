import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { loadWaTemplates, setWaTemplates, WA_DEFAULTS, PLACEHOLDERS } from './waTemplates'
import { CheckCircle, ChevronDown } from 'lucide-react'

const FIELDS = [
  ['wa_msg_prospect', 'Prospects', "New stores you haven't worked with yet", 'wa_link_prospect'],
  ['wa_msg_followup', 'Warm, cold, dormant & dropped', "Stores you've already been in touch with", 'wa_link_followup'],
  ['wa_msg_store', 'Onboarded stores', 'Stores you supply', 'wa_link_store'],
]
const SAMPLE = Object.fromEntries(PLACEHOLDERS.map(([p, , ex]) => [p, ex]))
const preview = t => (t || '').replace(/\{\w+\}/g, m => SAMPLE[m] ?? m)
const isUrl = v => /^https?:\/\//i.test((v || '').trim())

export default function WaTemplatesPanel() {
  const [vals, setVals] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showRef, setShowRef] = useState(true)
  const boxes = useRef({})

  useEffect(() => { loadWaTemplates().then(setVals) }, [])

  // Insert a placeholder at the cursor position of that message box
  function insert(key, token) {
    const el = boxes.current[key]
    const cur = vals[key] || ''
    const start = el?.selectionStart ?? cur.length
    const end = el?.selectionEnd ?? cur.length
    const next = cur.slice(0, start) + token + cur.slice(end)
    setVals(v => ({ ...v, [key]: next }))
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + token.length } })
  }

  async function save() {
    const bad = FIELDS.map(f => f[3]).find(k => vals[k] && !isUrl(vals[k]))
    if (bad) return setError('Links must start with https://')
    setSaving(true); setError('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error: e } = await supabase.from('user_settings').upsert({ user_id: user.id, ...vals }, { onConflict: 'user_id' })
    setSaving(false)
    if (e) return setError('Could not save: ' + e.message)
    setWaTemplates(vals)
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  if (!vals) return <p className="text-[var(--text-muted2)] text-sm">Loading...</p>
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[var(--text-muted2)] text-xs">
        Tapping WhatsApp on a store opens the chat with its group's message already typed. You can still edit it before sending.
      </p>

      <div className="bg-[var(--bg-card)]/50 border border-[var(--bg-input)]/50 rounded-2xl p-4">
        <button onClick={() => setShowRef(v => !v)} className="w-full flex items-center justify-between">
          <span className="text-[var(--text-primary)] text-sm font-medium">Placeholders you can use</span>
          <ChevronDown size={16} className={`text-[var(--text-muted2)] transition-transform ${showRef ? 'rotate-180' : ''}`} />
        </button>
        {showRef && (
          <>
            <p className="text-[var(--text-muted2)] text-[11px] mt-1 mb-2">
              Each one is replaced with that store's details when you tap WhatsApp. If a store has no data for one
              (e.g. a prospect with no deliveries), it's left blank — so use the delivery and call ones for warm/cold and onboarded stores.
            </p>
            <div className="flex flex-col">
              {PLACEHOLDERS.map(([p, desc, ex]) => (
                <div key={p} className="py-1.5 border-t border-[var(--bg-input)]/30 first:border-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs text-[var(--accent)]">{p}</span>
                    <span className="text-[11px] text-[var(--text-muted2)] truncate">e.g. {ex}</span>
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">{desc}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {FIELDS.map(([key, label, hint, linkKey]) => (
        <div key={key} className="bg-[var(--bg-card)]/50 border border-[var(--bg-input)]/50 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[var(--text-primary)] text-sm font-medium">{label}</span>
            <button onClick={() => setVals(v => ({ ...v, [key]: WA_DEFAULTS[key] }))} className="text-[var(--text-muted2)] text-xs">Reset</button>
          </div>
          <div className="text-[var(--text-muted2)] text-[11px] mb-2">{hint}</div>
          <div className="text-[var(--text-muted2)] text-[11px] mb-1">Tap to insert:</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {PLACEHOLDERS.map(([p]) => (
              <button key={p} type="button" onClick={() => insert(key, p)}
                className="px-2 py-1 rounded-md bg-[var(--bg-input)] text-[var(--text-secondary)] hover:text-[var(--accent)] font-mono text-[10px]">
                {p.slice(1, -1)}
              </button>
            ))}
          </div>
          <textarea ref={el => { boxes.current[key] = el }} rows={4} value={vals[key] || ''}
            onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))}
            className="w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none" />
          <label className="text-[var(--text-muted)] text-xs mt-3 mb-1 block">Link (optional) — brochure, price list, photo, Instagram…</label>
          <input type="url" inputMode="url" placeholder="https://..." value={vals[linkKey] || ''}
            onChange={e => setVals(v => ({ ...v, [linkKey]: e.target.value }))}
            className={`w-full bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] ${vals[linkKey] && !isUrl(vals[linkKey]) ? 'ring-1 ring-red-400' : ''}`} />
          {vals[linkKey] && !isUrl(vals[linkKey]) && <p className="text-red-400 text-[11px] mt-1">Start the link with https://</p>}
          <div className="text-[var(--text-muted2)] text-[11px] mt-2">Preview (sample store)</div>
          <div className="text-[var(--text-secondary)] text-xs bg-emerald-500/10 rounded-lg px-3 py-2 mt-1 whitespace-pre-wrap break-words">
            {[preview(vals[key]).trim(), (vals[linkKey] || '').trim()].filter(Boolean).join('\n\n') || <span className="opacity-60">(empty — chat opens with no message)</span>}
          </div>
        </div>
      ))}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <button onClick={save} disabled={saving}
        className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2">
        {saved ? <><CheckCircle size={18} /> Saved</> : saving ? 'Saving...' : 'Save messages'}
      </button>
    </div>
  )
}
