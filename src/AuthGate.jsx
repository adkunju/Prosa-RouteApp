import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => listener.subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className="min-h-screen bg-[var(--bg-root)] grid place-items-center">
      <div className="text-[var(--text-muted)]">Loading...</div>
    </div>
  )

  if (session) return children

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[var(--bg-root)] grid place-items-center">
      <div className="bg-[var(--bg-card)] p-8 rounded-2xl w-full max-w-sm shadow-xl">
        <h1 className="text-[var(--text-primary)] text-2xl font-bold mb-1">Route App</h1>
        <p className="text-[var(--text-muted)] text-sm mb-6">Sign in to continue</p>
        <div className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-4 py-2.5 outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="bg-[var(--bg-input)] text-[var(--text-primary)] rounded-lg px-4 py-2.5 outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            onClick={handleLogin}
            disabled={loading}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white font-semibold rounded-lg py-2.5 transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}
