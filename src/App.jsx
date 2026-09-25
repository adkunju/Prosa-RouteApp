import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import AuthGate from './AuthGate'
import { syncMatrix } from './matrixUtils'
import { startWaTemplateLoader, loadWaContext, setStoreStatus } from './waTemplates'
import CallFollowupPrompt from './CallFollowupPrompt'
import ConfirmHost from './ConfirmDialog'
import DashboardScreen from './DashboardScreen'
import ForecastScreen from './ForecastScreen'
import AllocationScreen from './AllocationScreen'
import PlanViewScreen from './PlanViewScreen'
import SalesScreen from './SalesScreen'
import WeekPlanScreen from './WeekPlanScreen'
import LogScreen from './LogScreen'
import SettingsScreen from './SettingsScreen'
import ProspectFinderScreen from './ProspectFinderScreen'
import { useTheme } from './useTheme'
import { LayoutDashboard, CalendarDays, ClipboardList, Truck, Settings, BarChart2, Search } from 'lucide-react'

const NAV = [
  { key: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { key: 'plan',      label: 'Plan',      Icon: CalendarDays },
  { key: 'delivery',  label: 'Delivery',  Icon: Truck },
  { key: 'sales',     label: 'Sales',     Icon: BarChart2 },
  { key: 'settings',  label: 'Settings',  Icon: Settings },
]

function PlanHub() {
  const [tab, setTab] = useState('week')
  useEffect(() => {
    const go = e => {
      if (e.detail?.screen) return // handled by Shell
      if (e.detail?.tab === 'settings_production') {
        sessionStorage.setItem('prosa_settings_return', 'plan:week')
        sessionStorage.setItem('prosa_settings_section', 'production')
        window.dispatchEvent(new CustomEvent('prosa:goto', { detail: { screen: 'settings' } }))
      } else if (e.detail?.tab === 'schedule') {
        setTab('week')
      } else if (e.detail?.tab) setTab(e.detail.tab)
    }
    window.addEventListener('prosa:goto', go)
    const goSettings = () => window.dispatchEvent(new CustomEvent('prosa:goto', { detail: { screen: 'settings' } }))
    window.addEventListener('prosa:settings_section', goSettings)
    return () => {
      window.removeEventListener('prosa:goto', go)
      window.removeEventListener('prosa:settings_section', goSettings)
    }
  }, [])
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex border-b border-[var(--bg-input)] shrink-0 overflow-x-auto">
        <button onClick={() => setTab('allocation')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'allocation' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Allocate
        </button>
        <button onClick={() => setTab('week')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'week' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Schedule
        </button>
        <button onClick={() => setTab('forecast')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'forecast' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Forecast
        </button>
      </div>
      {tab === 'allocation' && <AllocationScreen />}
      {tab === 'week' && <WeekPlanScreen />}
      {tab === 'forecast' && <ForecastScreen />}
    </div>
  )
}

function SalesHub() {
  const [tab, setTab] = useState('stores')
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex border-b border-[var(--bg-input)] shrink-0">
        <button onClick={() => setTab('stores')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'stores' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Stores
        </button>
        <button onClick={() => setTab('find')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'find' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Find
        </button>
      </div>
      {tab === 'stores' && <SalesScreen />}
      {tab === 'find' && <ProspectFinderScreen />}
    </div>
  )
}

function Shell() {
  const [screen, setScreen] = useState('dashboard')
  const { theme, setTheme } = useTheme()
  useEffect(() => {
    const go = e => {
      if (e.detail?.screen) {
        setScreen(e.detail.screen)
        if (e.detail.screen !== 'settings') sessionStorage.removeItem('prosa_settings_return')
        if (e.detail.tab) {
          setTimeout(() => window.dispatchEvent(new CustomEvent('prosa:goto', { detail: { tab: e.detail.tab } })), 100)
        }
      }
    }
    window.addEventListener('prosa:goto', go)
    return () => window.removeEventListener('prosa:goto', go)
  }, [])
  useEffect(() => {
    const stopLoader = startWaTemplateLoader()
    // store facts for message placeholders; refresh after calls and deliveries
    const refresh = () => loadWaContext().catch(() => {})
    refresh()
    const onStatus = e => setStoreStatus(e.detail?.storeId, e.detail?.status)
    window.addEventListener('prosa:call_logged', refresh)
    window.addEventListener('prosa:stock_changed', refresh)
    window.addEventListener('prosa:contacts_changed', refresh)
    window.addEventListener('prosa:pipeline_changed', onStatus)
    return () => {
      stopLoader()
      window.removeEventListener('prosa:call_logged', refresh); window.removeEventListener('prosa:stock_changed', refresh)
      window.removeEventListener('prosa:contacts_changed', refresh); window.removeEventListener('prosa:pipeline_changed', onStatus)
    }
  }, [])
  // Quietly fill travel times for any store that has none (no route-service call if nothing is missing)
  useEffect(() => {
    syncMatrix().then(r => {
      if (r.missing) {
        sessionStorage.removeItem('prosa_schedule_cache')
        window.dispatchEvent(new CustomEvent('prosa:matrix_updated'))
      }
    }).catch(e => console.error('travel matrix sync failed', e))
  }, [])
  return (
    <div className="h-screen bg-[var(--bg-root)] flex flex-col relative">
      <CallFollowupPrompt />
      <ConfirmHost />
      <div className="shrink-0 px-4 flex items-center bg-[var(--bg-root)]"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 22px)', paddingBottom: '12px' }}>
        <img src="/logo.png" alt="Prosa" className="h-8 w-auto object-contain" />
      </div>
      <main className="flex-1 flex flex-col overflow-hidden relative pb-20">
        {screen === 'dashboard' && <DashboardScreen />}
        {screen === 'plan'      && <PlanHub />}
        {screen === 'delivery'  && <PlanViewScreen />}
        {screen === 'sales'     && <SalesHub />}
        {screen === 'settings'  && <SettingsScreen theme={theme} setTheme={setTheme} />}
      </main>

      <nav className="fixed bottom-4 left-4 right-4 max-w-md mx-auto bg-[var(--bg-card)]/50 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.35)] flex z-50 p-1 gap-0.5">
        {NAV.map(({ key, label, Icon }) => {
          const active = screen === key
          return (
            <button key={key} onClick={() => setScreen(key)}
              className={`relative flex-1 flex flex-col items-center py-2 gap-0.5 text-[11px] font-medium rounded-xl transition-all
                ${active ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-white/5'}`}>
              {active && <span className="absolute inset-0 rounded-xl bg-[var(--accent)]/12 border border-[var(--accent)]/25 backdrop-blur-sm" />}
              <Icon size={18} className="relative z-10" />
              <span className="relative z-10">{label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

export default function App() {
  return <AuthGate><Shell /></AuthGate>
}
