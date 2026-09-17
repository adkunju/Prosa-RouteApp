import {useState, useEffect} from 'react'
import SkusScreen from './SkusScreen'
import ManageStoresList from './ManageStoresList'
import MatrixPanel from './MatrixPanel'
import { supabase } from './supabaseClient'
import { Package, Route, Store, ChevronRight, LogOut, RefreshCw, Sun, Moon, ClipboardList, FlaskConical } from 'lucide-react'
import BulkSyncPanel from './BulkSyncPanel'
import LogScreen from './LogScreen'
import ProductionScreen from './ProductionScreen'
import { useSettings } from './useSettings'

export default function SettingsScreen({ theme, setTheme }) {
  const { settings, update } = useSettings()
  const [section, setSection] = useState(() => {
    const s = sessionStorage.getItem('prosa_settings_section')
    if (s) { sessionStorage.removeItem('prosa_settings_section'); return s }
    return null
  })
  useEffect(() => {
    const fn = e => setSection(e.detail)
    window.addEventListener('prosa:settings_section', fn)
    return () => window.removeEventListener('prosa:settings_section', fn)
  }, []) // null | 'skus' | 'matrix' | 'stores'

  if (section === 'skus') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <SkusScreen />
      </div>
    )
  }

  if (section === 'production') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <ProductionScreen />
      </div>
    )
  }

  if (section === 'log') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <LogScreen />
      </div>
    )
  }

  if (section === 'stores') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <ManageStoresList />
      </div>
    )
  }

  if (section === 'sync') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <div className="flex-1 relative p-4">
          <BulkSyncPanel onClose={() => setSection(null)} />
        </div>
      </div>
    )
  }

  if (section === 'matrix') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <div className="px-4 py-3 border-b border-[var(--bg-input)] flex items-center gap-2 shrink-0">
          <button onClick={() => setSection(null)} className="text-[var(--text-accent)] text-sm">← Settings</button>
        </div>
        <div className="flex-1 relative p-4">
          <MatrixPanel onClose={() => setSection(null)} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 pb-28 flex flex-col gap-2">
      <button onClick={() => setSection('stores')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <Store size={18} className="text-[var(--text-gold)]" /> Manage Stores
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
      <button onClick={() => setSection('skus')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <Package size={18} className="text-[var(--text-accent)]" /> Manage SKU
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
      <button onClick={() => setSection('production')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <FlaskConical size={18} className="text-[var(--text-accent)]" /> Production Log
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
      <button onClick={() => setSection('log')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <ClipboardList size={18} className="text-[var(--text-accent)]" /> Delivery &amp; Return Log
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
      <button onClick={() => setSection('matrix')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <Route size={18} className="text-[var(--accent)]" /> Travel Matrix
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
      <button onClick={() => setSection('sync')}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          <RefreshCw size={18} className="text-purple-400" /> Sync stores with Google Maps
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>

      <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 mt-2">
        <div className="text-[var(--text-primary)] text-sm font-medium mb-1">Delivery days</div>
        <p className="text-[var(--text-muted2)] text-xs mb-3">Days you run deliveries. Untick the ones you skip.</p>
        <div className="flex gap-1.5">
          {[['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',7]].map(([label, n]) => {
            const on = (settings.delivery_weekdays || []).includes(n)
            return (
              <button key={n}
                onClick={() => {
                  const cur = settings.delivery_weekdays || []
                  const next = on ? cur.filter(x => x !== n) : [...cur, n].sort((a, b) => a - b)
                  if (next.length === 0) return
                  update({ delivery_weekdays: next })
                }}
                className={`flex-1 py-2 rounded-lg text-[11px] font-medium transition-colors ${on ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-input)] text-[var(--text-muted)]'}`}>
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--text-primary)] text-sm font-medium">Working hours per day</span>
          <span className="text-[var(--text-accent)] text-sm font-semibold">
            {Math.floor(settings.daily_budget_min / 60)}h{settings.daily_budget_min % 60 ? ` ${settings.daily_budget_min % 60}m` : ''}
          </span>
        </div>
        <p className="text-[var(--text-muted2)] text-xs mb-3">Driving plus time spent at each stop.</p>
        <input type="range" min={120} max={720} step={30}
          value={settings.daily_budget_min}
          onChange={ev => update({ daily_budget_min: Number(ev.target.value) })}
          className="w-full accent-[var(--accent)]" />
        <div className="flex justify-between text-[var(--text-muted2)] text-[10px] mt-1">
          <span>2h</span><span>12h</span>
        </div>
      </div>

      <div className="bg-[var(--bg-card)] backdrop-blur-xl border border-[var(--border-card)] rounded-2xl p-4 flex items-center justify-between mt-2">
        <span className="flex items-center gap-3 text-[var(--text-primary)] text-sm font-medium">
          {theme === 'dark' ? <Moon size={18} className="text-[var(--text-accent)]" /> : <Sun size={18} className="text-[var(--text-gold)]" />}
          App Theme
        </span>
        <div className="flex bg-[var(--bg-input)] rounded-full p-1">
          <button onClick={() => setTheme('light')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${theme === 'light' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>
            Light
          </button>
          <button onClick={() => setTheme('dark')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${theme === 'dark' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)]'}`}>
            Dark
          </button>
        </div>
      </div>

      <button onClick={() => supabase.auth.signOut()}
        className="bg-[var(--bg-card)]/50 backdrop-blur-xl border border-[var(--bg-input)]/50 rounded-2xl p-4 flex items-center justify-between hover:bg-[var(--bg-input)]/40 transition-colors mt-2">
        <span className="flex items-center gap-3 text-red-400 text-sm font-medium">
          <LogOut size={18} /> Sign out
        </span>
        <ChevronRight size={16} className="text-[var(--text-muted2)]" />
      </button>
    </div>
  )
}
