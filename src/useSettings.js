import { useEffect, useState, useCallback, useRef } from 'react'
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
  const saveTimer = useRef(null)
  const pendingRef = useRef(null)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoaded(true); return }
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
    if (data) setSettings({ ...DEFAULTS, ...data })
    else await supabase.from('user_settings').upsert({ user_id: user.id, ...DEFAULTS })
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

  const update = useCallback((patch) => {
    setSettings(s => {
      const next = { ...s, ...patch }
      pendingRef.current = next
      // Debounce DB write — only save after 600ms of no changes
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user || !pendingRef.current) return
        await supabase.from('user_settings')
          .upsert({ user_id: user.id, ...pendingRef.current, updated_at: new Date().toISOString() })
      }, 600)
      return next
    })
  }, [])

  return { settings, update, loaded }
}
