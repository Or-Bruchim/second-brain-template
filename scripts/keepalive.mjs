#!/usr/bin/env node
/**
 * Supabase keep-alive — the free-tier project auto-pauses after ~7 days with
 * no database activity, which drops it off DNS entirely (see incident
 * 2026-07-15: embed.mjs failed with ENOTFOUND after a 3-week gap between
 * pushes). This does one trivial read so the project always looks "active,"
 * run on a cadence well inside the 7-day window.
 *
 * Required env vars:
 *   SUPABASE_URL         — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role JWT (server-side only)
 */
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
  process.exit(1)
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/chunks?select=id&limit=1`, {
  headers: {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
  },
})

if (!res.ok) {
  const err = await res.text()
  throw new Error(`Keep-alive ping failed (${res.status}): ${err}`)
}

console.log(`Keep-alive OK — ${new Date().toISOString()}`)
