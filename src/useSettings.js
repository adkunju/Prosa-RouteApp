import { useEffect, useState, useCallback } from 'react'
import { supabase } from './supabaseClient'

const DEFAULTS = {
  delivery_days_per_week: 6,
  daily_budget_min: 360,
  allow_early_visit_days: 1,
  delivery_weekdays: [1, 2, 3, 4, 5, 6],
}

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULTS)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoaded(true); return }
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
    if (data) setSettings({ ...DEFAULTS, ...data })
    else await supabase.from('user_settings').upsert({ user_id: user.id, ...DEFAULTS })
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

  async function update(patch) {
    setSettings(s => ({ ...s, ...patch }))
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('user_settings')
      .upsert({ user_id: user.id, ...settings, ...patch, updated_at: new Date().toISOString() })
  }

  return { settings, update, loaded }
}
