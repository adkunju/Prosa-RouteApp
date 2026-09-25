import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

// In-app yes/no popup (the browser's own confirm() box can be blocked or silently skipped on phones).
// Usage: if (!(await askConfirm({ title, lines, okLabel }))) return
let opener = null

export function askConfirm(opts) {
  if (!opener) return Promise.resolve(window.confirm([opts.title, ...(opts.lines || [])].join('\n')))
  return new Promise(resolve => opener({ ...opts, resolve }))
}

export default function ConfirmHost() {
  const [dlg, setDlg] = useState(null)
  useEffect(() => { opener = setDlg; return () => { opener = null } }, [])
  if (!dlg) return null
  const close = (ok) => { dlg.resolve(ok); setDlg(null) }
  return createPortal(
    <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" onClick={() => close(false)}>
      <div className="bg-[var(--bg-card)] rounded-2xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-[var(--text-primary)] font-semibold mb-2">{dlg.title}</div>
        {dlg.intro && <p className="text-[var(--text-muted2)] text-xs mb-2">{dlg.intro}</p>}
        {!!dlg.lines?.length && (
          <ul className="text-sm text-[var(--text-secondary)] flex flex-col gap-1.5 mb-3">
            {dlg.lines.map((l, i) => <li key={i}>• {l}</li>)}
          </ul>
        )}
        {dlg.question && <p className="text-sm text-[var(--text-primary)] mb-4">{dlg.question}</p>}
        <div className="flex gap-2">
          <button onClick={() => close(false)} className="flex-1 py-2.5 rounded-xl border border-[var(--bg-input)] text-[var(--text-secondary)] text-sm">{dlg.cancelLabel || 'Cancel'}</button>
          <button onClick={() => close(true)} className={`flex-1 py-2.5 rounded-xl text-white text-sm font-semibold ${dlg.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[var(--accent)]'}`}>{dlg.okLabel || 'OK'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
