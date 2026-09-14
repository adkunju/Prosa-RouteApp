import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import AuthGate from './AuthGate'
import DashboardScreen from './DashboardScreen'
import ProductionScreen from './ProductionScreen'
import ForecastScreen from './ForecastScreen'
import AllocationScreen from './AllocationScreen'
import PlanViewScreen from './PlanViewScreen'
import WeekPlanScreen from './WeekPlanScreen'
import LogScreen from './LogScreen'
import SettingsScreen from './SettingsScreen'
import { useTheme } from './useTheme'
import { LayoutDashboard, CalendarDays, ClipboardList, Truck, Settings } from 'lucide-react'

const NAV = [
  { key: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { key: 'plan',      label: 'Plan',      Icon: CalendarDays },
  { key: 'delivery',  label: 'Delivery',  Icon: Truck },
  { key: 'settings',  label: 'Settings',  Icon: Settings },
]

function PlanHub() {
  const [tab, setTab] = useState('allocation')
  useEffect(() => {
    const go = e => { if (e.detail?.tab) setTab(e.detail.tab) }
    window.addEventListener('prosa:goto', go)
    return () => window.removeEventListener('prosa:goto', go)
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
        <button onClick={() => setTab('production')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'production' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Production
        </button>
        <button onClick={() => setTab('forecast')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-2 ${tab === 'forecast' ? 'text-[var(--text-accent)] border-b-2 border-[var(--text-accent)]' : 'text-[var(--text-muted2)]'}`}>
          Forecast
        </button>
      </div>
      {tab === 'allocation' && <AllocationScreen />}
      {tab === 'week' && <WeekPlanScreen />}
      {tab === 'production' && <ProductionScreen />}
      {tab === 'forecast' && <ForecastScreen />}
    </div>
  )
}

function Shell() {
  const [screen, setScreen] = useState('dashboard')
  const { theme, setTheme } = useTheme()
  return (
    <div className="h-screen bg-[var(--bg-root)] flex flex-col relative">
      <div className="shrink-0 px-4 flex items-center bg-[var(--bg-root)]"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 22px)', paddingBottom: '12px' }}>
        <img src="/logo.png" alt="Prosa" className="h-8 w-auto object-contain" />
      </div>
      <main className="flex-1 flex flex-col overflow-hidden relative pb-20">
        {screen === 'dashboard' && <DashboardScreen />}
        {screen === 'plan'      && <PlanHub />}
        {screen === 'delivery'  && <PlanViewScreen />}
        {screen === 'settings'  && <SettingsScreen theme={theme} setTheme={setTheme} />}
      </main>

      <nav className="fixed bottom-4 left-4 right-4 max-w-md mx-auto bg-[var(--bg-card)]/60 backdrop-blur-2xl border border-[var(--bg-input)]/50 rounded-2xl shadow-2xl flex z-50">
        {NAV.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setScreen(key)}
            className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 text-[11px] transition-colors ${screen === key ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-heading2)]'}`}>
            <Icon size={18} />{label}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default function App() {
  return <AuthGate><Shell /></AuthGate>
}
