import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabaseClient'

export const STATUSES = ['prospect','onboard','warm','cold','dormant','dropped']

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
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) {
        // also check if click is inside the portal dropdown
        const portal = document.getElementById('pipeline-portal')
        if (portal && portal.contains(e.target)) return
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  const [saving, setSaving] = useState(false)
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'

  async function set(s) {
    setSaving(true)
    const { error } = await supabase.from('stores').update({
      pipeline_status: s,
      pipeline_updated_by: 'user',
      pipeline_updated_at: new Date().toISOString(),
    }).eq('id', storeId)
    setSaving(false)
    setOpen(false)
    onChanged?.(s)
  }

  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  function openWithPos() {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const dropH = 224
      const spaceBelow = window.innerHeight - r.bottom
      const top = spaceBelow < dropH + 20
        ? Math.max(8, r.top - dropH - 6)
        : r.bottom + 4
      const left = Math.min(r.left, window.innerWidth - 160)
      setPos({ top, left })
      setOpen(true)
    }
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button ref={btnRef} onClick={openWithPos}
        className={`${px} rounded-full border font-medium transition-all shadow-sm hover:shadow-md ${COLORS[status] || COLORS.prospect} ${saving ? 'opacity-50' : ''} flex items-center gap-0.5`}>
        <span>{status}</span>
        {updatedBy === 'system' && <span className="opacity-50 text-[9px]">auto</span>}
        <span className="opacity-60 text-[9px] ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && createPortal(
        <div id="pipeline-portal" style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="bg-[var(--bg-card)] border border-[var(--bg-input)]/60 rounded-xl p-1.5 shadow-2xl min-w-[130px] max-h-56 overflow-y-auto"
          onClick={e => e.stopPropagation()}>
          {STATUSES.map(s => (
            <button key={s} onClick={() => set(s)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${s === status ? COLORS[s] + ' font-medium' : 'text-[var(--text-muted2)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-input)]/40'}`}>
              {s}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
