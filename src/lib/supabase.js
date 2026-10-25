import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Every request gives up after 15s, so nothing can hang forever.
// (AbortController + timer instead of AbortSignal.timeout, which older Safari versions lack.)
export async function fetchWithTimeout(input, init = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  init.signal?.addEventListener('abort', () => controller.abort());
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The app has no user accounts, so Supabase Auth is switched off: no stored sessions,
// no token-refresh timers, no background activity. Only direct calls made by the user's clicks.
export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetchWithTimeout(input, init) },
    })
  : null;
export const hasSupabase = Boolean(supabase);
