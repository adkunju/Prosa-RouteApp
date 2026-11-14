import { useSyncExternalStore } from 'react'

// Desktop layout starts at 1024px wide — the same point as Tailwind's "lg:" classes.
const QUERY = '(min-width: 1024px)'

function subscribe(onChange) {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function useIsDesktop() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches)
}
