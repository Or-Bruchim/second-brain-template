import { escapeHtmlTg } from "./util.js"

export async function sendPhoto(token, chatId, imageBuffer, caption) {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'image.jpg')
  if (caption) form.append('caption', caption.slice(0, 1024))
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form })
  const data = await res.json().catch(() => null)
  return data?.result?.message_id ?? null
}

export async function getTelegramFileUrl(fileId, botToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
    const data = await res.json()
    if (data.ok) return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`
  } catch {}
  return null
}

export async function sendTelegram(token, chatId, text, parseMode, replyMarkup) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true }
  if (parseMode) body.parse_mode = parseMode
  if (replyMarkup) body.reply_markup = replyMarkup
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => null)
  return data?.result?.message_id ?? null
}

export async function pollUntilLive(env, chatId, msgId, url, finalText) {
  const savedAt = Date.now()
  const maxAttempts = 15 // 15 × 25s ≈ 6 min
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 25_000))
    try {
      // Primary: check if the latest deploy workflow completed after this save
      const deployed = await checkDeployDone(env, savedAt)
      if (deployed) {
        await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, finalText, 'HTML')
        return
      }
      // Fallback: direct HEAD (works on open sites; 401/403 = auth-gated = page exists)
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
      if (res.ok || res.status === 401 || res.status === 403) {
        await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, finalText, 'HTML')
        return
      }
    } catch {}
  }
}

export async function checkDeployDone(env, afterMs) {
  // Cloudflare Pages auto-deploys without a GitHub Actions run — fall back to time-based.
  // If 3+ minutes have passed since the commit, assume the deploy is done.
  return Date.now() - afterMs > 3 * 60 * 1000
}

// Instant ack reaction — Telegram only allows certain emoji, see core.telegram.org/bots/api#reactiontypeemoji
export async function reactToMessage(token, chatId, messageId, emoji = '👀') {
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      }),
    })
  } catch (err) { console.error('reactToMessage error:', err) }
}

export async function sendTyping(token, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    })
  } catch {}
}

// Set the bot's menu button to a Web App link for the Brain site.
// Cached in KV (30 days) per chat so we only call the API once.
export async function ensureWebAppButton(token, chatId, env) {
  if (!env.BRAIN_KV || !env.SITE_URL) return
  const kvKey = `webapp_set:${chatId}`
  try {
    const already = await env.BRAIN_KV.get(kvKey)
    if (already) return
    await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        menu_button: { type: 'web_app', text: '🧠 Brain', web_app: { url: env.SITE_URL } },
      }),
    })
    await env.BRAIN_KV.put(kvKey, '1', { expirationTtl: 86400 * 30 })
  } catch {}
}

export async function handleStartCommand(message, env) {
  const payload = (message.text || '').replace(/^\/start\s*/, '').trim()
  const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'

  if (payload.startsWith('note_')) {
    const ts = payload.slice(5)
    try {
      const res = await fetch(`${siteUrl}/static/contentIndex.json`, { cf: { cacheTtl: 60 } })
      if (res.ok) {
        const index = await res.json()
        const entry = Object.entries(index).find(([slug]) => slug.endsWith(ts))
        if (entry) {
          const [slug, meta] = entry
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id,
            `🧠 <b>${escapeHtmlTg(meta.title || slug)}</b>\n\n🔗 <a href="${siteUrl}/${slug}">Open in Brain</a>\n\n💬 שאל אותי על הנוטה הזו עם /ask`, 'HTML')
          return
        }
      }
    } catch {}
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '⚠️ הנוטה לא נמצאה. ייתכן שעדיין בפריסה — נסה שוב בעוד דקה.')
    return
  }

  await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id,
    `🧠 <b>Second Brain Bot</b>\n\nשלח לי לינק, מחשבה, שאלה — ואני אשמור ואנתח.\n\n<b>פקודות:</b>\n/ask — שאל שאלה על מה ששמרת\n/report — ייצא דוח\n/reminders — תזכורות שפעילות\n/delete — מחק נוטה`,
    'HTML')
}

export async function sendTelegramDocument(token, chatId, filename, content, caption, mimeType = 'text/html') {
  const formData = new FormData()
  formData.append('chat_id', String(chatId))
  formData.append('document', new Blob([content], { type: mimeType }), filename)
  if (caption) {
    formData.append('caption', caption)
    formData.append('parse_mode', 'HTML')
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: formData,
  })
  const data = await res.json().catch(() => null)
  return data?.result?.message_id ?? null
}

export async function editTelegramMessage(token, chatId, messageId, text, parseMode) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: parseMode, disable_web_page_preview: true }),
  })
}

export async function answerCallbackQuery(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  })
}