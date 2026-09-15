import { useState } from 'react'
import { supabase } from './supabaseClient'

const STATUSES = ['prospect','onboard','active','warm','cold','dormant','dropped']

const COLORS = {
  prospect:  'bg-slate-700/60 text-slate-300 border-slate-600/40',
  onboard:   'bg-blue-900/60 text-blue-300 border-blue-700/40',
  active:    'bg-emerald-900/60 text-emerald-300 border-emerald-700/40',
  warm:      'bg-amber-900/60 text-amber-300 border-amber-700/40',
  cold:      'bg-sky-900/60 text-sky-300 border-sky-700/40',
  dormant:   'bg-orange-900/60 text-orange-300 border-orange-700/40',
  dropped:   'bg-red-900/60 text-red-300 border-red-700/40',
}

export default function PipelineTag({ storeId, status, updatedBy, onChanged, size = 'sm' }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'

  async function set(s) {
    setSaving(true)
    await supabase.from('stores').update({
      pipeline_status: s,
      pipeline_updated_by: 'user',
      pipeline_updated_at: new Date().toISOString(),
    }).eq('id', storeId)
    setSaving(false)
    setOpen(false)
    onChanged?.(s)
  }

  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen(v => !v)}
        className={`${px} rounded-full border font-medium transition-colors ${COLORS[status] || COLORS.prospect} ${saving ? 'opacity-50' : ''}`}>
        {status}{updatedBy === 'system' ? ' ·auto' : ''}
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-xl p-1.5 shadow-2xl min-w-[130px]"
          onClick={e => e.stopPropagation()}>
          {STATUSES.map(s => (
            <button key={s} onClick={() => set(s)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${s === status ? COLORS[s] + ' font-medium' : 'text-[var(--text-muted2)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-input)]/40'}`}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
