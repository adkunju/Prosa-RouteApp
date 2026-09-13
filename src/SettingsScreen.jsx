import { useState } from 'react'
import SkusScreen from './SkusScreen'
import ManageStoresList from './ManageStoresList'
import MatrixPanel from './MatrixPanel'
import { supabase } from './supabaseClient'
import { Package, Route, Store, ChevronRight, LogOut, RefreshCw, Sun, Moon, ClipboardList } from 'lucide-react'
import BulkSyncPanel from './BulkSyncPanel'
import LogScreen from './LogScreen'

export default function SettingsScreen({ theme, setTheme }) {
  const [section, setSection] = useState(null) // null | 'skus' | 'matrix' | 'stores'

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
