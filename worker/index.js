import { CORS_HEADERS } from "./constants.js"
import { handleMemoryRefresh, handleReportGenerate, sendDailyDigest, sendWeeklyReview } from "./digest.js"
import { handleAuth, handleChat, handleNoteDelete, handleNoteGet, handleNoteUpdate, handleSave, handleSynthesisSave, handleTelegramWebhook, processReminders } from "./handlers.js"

// ── Router ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
    if (url.pathname === '/health') return new Response('OK')
    if (url.pathname === '/webhook' && request.method === 'POST') return handleTelegramWebhook(request, env, ctx)
    if (url.pathname === '/auth' && request.method === 'POST') return handleAuth(request, env)
    if (url.pathname === '/chat' && request.method === 'POST') return handleChat(request, env)
    if (url.pathname === '/save' && request.method === 'POST') return handleSave(request, env)
    if (url.pathname === '/synthesis/save' && request.method === 'POST') return handleSynthesisSave(request, env)
    if (url.pathname === '/note' && request.method === 'GET') return handleNoteGet(request, env)
    if (url.pathname === '/note/update' && request.method === 'POST') return handleNoteUpdate(request, env)
    if (url.pathname === '/note/delete' && request.method === 'POST') return handleNoteDelete(request, env)
    if (url.pathname === '/memory/refresh' && request.method === 'GET') return handleMemoryRefresh(request, env)
    if (url.pathname === '/report/generate' && request.method === 'POST') return handleReportGenerate(request, env)
    return new Response('Not Found', { status: 404 })
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processReminders(env))
    if (event.cron === '0 5 * * *') ctx.waitUntil(sendDailyDigest(env))
    if (event.cron === '0 6 * * 7') ctx.waitUntil(sendWeeklyReview(env))
    // Keepalive: ping Supabase so the free-tier project never goes idle (pauses after 7 days).
    // This cron runs every 15 min — project stays permanently active.
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      ctx.waitUntil(
        fetch(`${env.SUPABASE_URL}/rest/v1/chunks?select=id&limit=1`, {
          headers: {
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            apikey: env.SUPABASE_SERVICE_KEY,
          },
        }).catch(() => {}),
      )
    }
  },
}