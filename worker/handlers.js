import { analyzeAttachment, extractImageContent, geminiWebSearch, generateHtmlWithCfAI, generateHtmlWithGemini } from "./ai.js"
import { GIT_IDENTITY, SESSION_TTL_SECONDS } from "./constants.js"
import { handleExportCommand, handleStubContextReply, handleTelegramReport, updateMemoryProfile } from "./digest.js"
import { commitFile, deleteGithubFile, deleteNote, triggerDeploy } from "./github.js"
import { META_INSTRUCTION_RE, aiDetectRecipe, isArtifactCreateIntent, isArtifactEditIntent, routeIntent } from "./intent.js"
import { analyzeVideoContent, analyzeWithAI, detectVideoPlatform, extractUrls, fetchRichMeta, handleSaveVideo, handleVoiceMessage, processDocumentMessage, processVideoMessage } from "./media.js"
import { deleteChunksByNote, expandQueryBilingually, getRecentNotes, retrieveRelevantNotes, upsertVector } from "./retrieve.js"
import { answerCallbackQuery, editTelegramMessage, ensureWebAppButton, getTelegramFileUrl, handleStartCommand, pollUntilLive, reactToMessage, sendPhoto, sendTelegram, sendTelegramDocument, sendTyping } from "./telegram.js"
import { base64ToBytes, decodeGithubContent, encodeGithubContent, escapeHtmlTg, extractPhoneNumbers, handlePhoneNumber, jsonResponse, looksLikePhoneMessage, sanitizeSlug, simpleHash } from "./util.js"

// ── Image generation ──────────────────────────────────────────────────
export async function handleImageGeneration(message, env) {
  let prompt = (message.text || '').trim()
    .replace(/^\/image\s*/i, '').replace(/^\/img\s*/i, '')
    .replace(/^(צור|ייצר|תצייר|תייצר|תייצור|צייר|תיצור)\s+(תמונה|ציור|איור|תמונת)\s+(של\s+)?/i, '')
    .replace(/^(generate|create|draw|make|render)\s+(a\s+|an\s+)?(image|picture|photo|illustration|drawing|painting)\s+(of\s+)?/i, '')
    .trim()

  if (!prompt) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id,
      '❓ מה לצייר?\n\nלדוגמה: <code>צור תמונה של עיר עתידנית בסגנון anime</code>', 'HTML')
    return
  }

  // Translate Hebrew prompt to English — image models work much better in English
  if (/[֐-׿]/.test(prompt)) {
    try {
      const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'Translate the following image generation prompt from Hebrew to English. Return ONLY the translated prompt, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
      })
      if (r.response?.trim()) prompt = r.response.trim()
    } catch {}
  }

  // Show camera upload indicator + status message
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: message.chat.id, action: 'upload_photo' }),
  })
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `🎨 מייצר: <i>${escapeHtmlTg(prompt.slice(0, 120))}</i>…`, 'HTML')

  try {
    const stream = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', { prompt })
    const imageBuffer = await new Response(stream).arrayBuffer()
    await sendPhoto(env.TELEGRAM_BOT_TOKEN, message.chat.id, imageBuffer, prompt.slice(0, 200))
  } catch (err) {
    console.error('handleImageGeneration error:', err)
    const msg = err.message || ''
    const userMsg = msg.includes('overload') || msg.includes('capacity')
      ? '❌ <b>מודל עמוס כרגע</b>\n\n💡 נסה שוב בעוד 30 שניות.'
      : `❌ <b>יצירת התמונה נכשלה</b>\n\n<code>${escapeHtmlTg(msg.slice(0, 120))}</code>\n\n💡 נסה תיאור פשוט יותר.`
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, userMsg, 'HTML')
  }
}

// CALENDAR captures (events with a time) are handled as time-based reminders —
// there is no separate calendar backend. Aliased so the intent never crashes.
export async function handleCalendarEvent(message, env) {
  return handleSetReminder(message, env)
}

export async function handleTelegramWebhook(request, env, ctx) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 })
  let update
  try { update = await request.json() } catch { return new Response('Bad Request', { status: 400 }) }

  if (update.callback_query) {
    ctx.waitUntil(handleCallback(update.callback_query, env))
    return new Response('OK')
  }

  const message = update.message || update.channel_post
  if (!message) return new Response('OK')
  if (env.ALLOWED_CHAT_IDS) {
    const allowed = env.ALLOWED_CHAT_IDS.split(',').map(s => s.trim())
    if (!allowed.includes(String(message.chat.id))) return new Response('OK')
  }

  // Instant ack — fire-and-forget so user sees 👀 immediately
  ctx.waitUntil(reactToMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, message.message_id, '👀'))
  ctx.waitUntil(ensureWebAppButton(env.TELEGRAM_BOT_TOKEN, message.chat.id, env))

  if (message.voice || message.audio) {
    ctx.waitUntil(handleVoiceMessage(message, env))
    return new Response('OK')
  }

  // Reply to stub link save → add context to the inbox file
  if (message.reply_to_message?.text?.includes('שמרתי את הלינק')) {
    ctx.waitUntil(handleStubContextReply(message, env))
    return new Response('OK')
  }

  const text = message.text || message.caption || ''
  if (text.startsWith('/start')) {
    ctx.waitUntil(handleStartCommand(message, env))
  } else if (text.startsWith('/delete')) {
    ctx.waitUntil(handleDeleteCommand(message, env))
  } else if (text.startsWith('/ask')) {
    ctx.waitUntil(handleTelegramQuery(message, env))
  } else if (text.startsWith('/report')) {
    ctx.waitUntil(handleTelegramReport(message, env))
  } else if (text.startsWith('/reminders')) {
    ctx.waitUntil(handleListReminders(message, env))
  } else if (text.startsWith('/export')) {
    ctx.waitUntil(handleExportCommand(message, env))
  } else if (text.startsWith('/search')) {
    ctx.waitUntil(handleSearch(message, env))
  } else if (text.startsWith('/later')) {
    ctx.waitUntil(handleLater(message, env))
  } else if (text.startsWith('/queue')) {
    ctx.waitUntil(handleShowQueue(message, env))
  } else if (text.startsWith('/html') || isArtifactCreateIntent(text)) {
    ctx.waitUntil(handleGenerateArtifact(message, env))
  } else if (text.startsWith('/edit') || isArtifactEditIntent(text, message)) {
    ctx.waitUntil(handleEditArtifact(message, env))
  } else if (looksLikePhoneMessage(text)) {
    ctx.waitUntil(handlePhoneNumber(message, extractPhoneNumbers(text), env))
  } else {
    // ── Unified intent classifier — replaces the prior chain of regex/AI detectors ──
    ctx.waitUntil((async () => {
      try {
        const hasMedia = !!(message.photo || message.document || message.video)
        const urlsForRouting = extractUrls(text, message.entities || message.caption_entities || [])
        const { intent } = await routeIntent({ text, hasMedia, hasUrl: urlsForRouting.length > 0, env })

        switch (intent) {
          case 'QUERY':      return handleTelegramQuery({ ...message, text }, env)
          case 'JOURNAL':    return handleJournalEntry(message, env)
          case 'RECIPE':     return handleRecipeEntry(message, env)
          case 'REMINDER':   return handleSetReminder(message, env)
          case 'WEB_SEARCH': return handleWebSearch(message, env)
          case 'IMAGE_GEN':  return handleImageGeneration(message, env)
          case 'CALENDAR':   return handleCalendarEvent(message, env)
          case 'META':       return handleMetaInstruction(message, env)
          case 'SKIP': {
            const greeting = /^(היי|הי|שלום|אהלן|הלו|מה נשמע|מה קורה|מה המצב)/.test(text.trim()) ||
              /^(hi|hey|hello|sup|yo)\b/i.test(text.trim())
            if (greeting) {
              await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '👋 היי! שלח לי לינק, רעיון, שאלה — ואני אטפל בזה.')
            }
            return
          }
          case 'ASK': {
            const confirmMarkup = { inline_keyboard: [[
              { text: '✅ כן, שמור', callback_data: 'confirm:save' },
              { text: '❌ לא', callback_data: 'confirm:skip' },
            ]]}
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: message.chat.id,
                text: '🤔 לא בטוח אם זה מידע לשמור או סתם שיחה.\nלשמור?',
                reply_to_message_id: message.message_id,
                reply_markup: confirmMarkup,
              }),
            })
            return
          }
          case 'SAVE':
          default:
            return processMessage(message, env, { ctx, skipClassifier: true })
        }
      } catch (err) {
        console.error('routeIntent error:', err)
        return processMessage(message, env, { ctx })
      }
    })())
  }
  return new Response('OK')
}

export async function handleCallback(query, env) {
  try {
    const data = query.data || ''
    if (data.startsWith('del:')) {
      const slug = data.slice(4)
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '🗑 מוחק...')
      const { mainFound } = await deleteNote(slug, env)
      const newText = mainFound
        ? `🗑 <i>נמחק מהמוח: ${escapeHtmlTg(slug)}</i>`
        : `⚠️ <i>נוטה לא נמצאה: ${escapeHtmlTg(slug)}</i>`
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, newText, 'HTML')
    } else if (data === 'confirm:save') {
      const original = query.message?.reply_to_message
      if (!original) {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '⚠️ ההודעה המקורית לא נמצאה')
        return
      }
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '💾 שומר...')
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, '💾 <i>שומר...</i>', 'HTML')
      await processMessage(original, env, { skipClassifier: true })
    } else if (data === 'confirm:skip') {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '👀 לא נשמר')
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, '👀 <i>לא נשמר</i>', 'HTML')
    } else if (data.startsWith('cancel_reminder:')) {
      const key = data.slice(16)
      const val = await env.BRAIN_KV.get(key, 'json')
      if (val) {
        await env.BRAIN_KV.delete(key)
        // If this was the earliest reminder, refresh the cache (one list op — rare, only on cancel)
        const canceledTs = parseInt(key.split(':')[1], 10)
        const nextStr = await env.BRAIN_KV.get('meta:reminder_next')
        if (!nextStr || canceledTs <= parseInt(nextStr, 10)) {
          await updateNextReminder(env)
        }
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '✅ בוטל')
        await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, `🗑 <i>תזכורת בוטלה: "${escapeHtmlTg(val.message)}"</i>`, 'HTML')
      } else {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '⚠️ תזכורת כבר לא קיימת')
      }
    } else if (data.startsWith('save_anyway:')) {
      const pendingId = data.slice(12)
      const msg = await env.BRAIN_KV.get(`pending:${pendingId}`, 'json')
      if (!msg) {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '⏱ פג תוקף — שלח שוב')
        return
      }
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '💾 שומר...')
      await env.BRAIN_KV.delete(`pending:${pendingId}`)
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, '💾 <i>שומר...</i>', 'HTML')
      await processMessage(msg, env, { skipClassifier: true, skipDuplicateCheck: true })
    } else if (data.startsWith('process_later:')) {
      const key = data.slice(14)
      const val = await env.BRAIN_KV.get(key, 'json')
      if (!val) {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '⚠️ פריט לא נמצא')
        return
      }
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '⚡ מעבד...')
      await env.BRAIN_KV.delete(key)
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, '⚡ <i>מעבד...</i>', 'HTML')
      const synth = {
        chat: { id: parseInt(val.chatId) },
        message_id: val.messageId || 0,
        text: val.originalText || val.text,
        date: Math.floor((val.ts || Date.now()) / 1000),
      }
      await processMessage(synth, env, { skipClassifier: true, skipDuplicateCheck: true })
    } else if (data.startsWith('delete_later:')) {
      const key = data.slice(13)
      await env.BRAIN_KV.delete(key)
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '🗑 הוסר')
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, query.message.chat.id, query.message.message_id, '🗑 <i>הוסר מהתור</i>', 'HTML')
    } else {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, '')
    }
  } catch (err) {
    console.error('handleCallback error:', err)
    const label = (err.message || '').includes('GitHub') ? '❌ שגיאה ב-GitHub' : '❌ פעולה נכשלה'
    try { await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, label) } catch {}
  }
}

export async function handleDeleteCommand(message, env) {
  const slug = (message.text || '').replace(/^\/delete\s*/, '').trim().replace(/^inbox\//, '')
  if (!slug) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '❓ Usage: /delete <slug>\nExample: /delete 2026-04-28-1777362963000')
    return
  }
  try {
    const { mainFound } = await deleteNote(slug, env)
    if (mainFound) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `🗑 נמחק: <code>${escapeHtmlTg(slug)}</code>`, 'HTML')
    } else {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `⚠️ לא נמצאה נוטה בשם: <code>${escapeHtmlTg(slug)}</code>`, 'HTML')
    }
  } catch (err) {
    console.error('handleDeleteCommand error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `❌ שגיאה במחיקה: ${err.message}`)
  }
}

// ── /ask: query the brain without saving ─────────────────────────────
export async function handleTelegramQuery(message, env) {
  const question = (message.text || '').replace(/^\/ask\s*/, '').trim()
  if (!question) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '❓ Usage: /ask <your question>\nExample: /ask what did I save about RAG?')
    return
  }
  try {
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'

    // ── Meta queries: answer directly without note search ────────────
    const q = question.toLowerCase()

    // Knowledge-intent signals override all meta shortcuts below
    const isKnowledgeQuery = /איזה ידע|מה יש לי|מה שמרתי|יש לי על|שמרתי על|מה אצלי|תחפש לי|תמצא לי|מה למדתי|what do i have|what did i save|find me|search for/i.test(question)

    if (!isKnowledgeQuery) {
      // Only fire if user is clearly asking for the site URL itself, not about websites in general
      const hasLinkWord = q.includes('לינק') || q.includes('url') || q.includes('כתובת')
      const hasSiteWord = /\b(האתר|לאתר|brain|quartz)\b/.test(q)
      if (hasLinkWord || hasSiteWord) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `🔗 הלינק לאתר שלך:\n${siteUrl}`)
        return
      }
    }
    // Identity / self-meta / capability queries — answer directly, no RAG, no irrelevant note list
    const qTrim = question.trim()
    const identityPatterns = [
      /^(מי אתה|מה אתה|מי את|מה את)\b[?؟. ]*$/i,
      /^(ספר לי|תספר לי|תציג את עצמך|הצג את עצמך)\b/i,
      /^(מה אתה (יכול|יודע|עושה)|מה ה(בוט|עוזר) הזה|מה זה|מה התפקיד שלך)/i,
      /^(תסביר את עצמך|מה היכולות שלך|איך אתה עובד)/i,
      /^(אילו|איזה|מה ה)?\s*(כלים|פיצ'?רים|פיצרים|פקודות|יכולות|אופציות|פונקציות)\s*(יש לך|יש|אתה מציע|אתה תומך|זמינות|זמינים)?[?؟. ]*$/i,
      /^(עזרה|\/help|help)\b[?!.]*$/i,
      /^(who are you|what are you|tell me about yourself|introduce yourself)\b/i,
      /^(what can you do|what do you do|how do you work|your capabilities)/i,
      /^(what|which)\s+(tools|features|commands|capabilities)\s+(do you have|are there|do you support)?/i,
    ]
    const isIdentityQuery = identityPatterns.some(p => p.test(qTrim))
    if (isIdentityQuery) {
      const bio = `🧠 אני המוח השני של אור — בוט אישי שמרכז רעיונות, רגשות, לינקים ותובנות.\n\n<b>שמירה</b>\n• שלח טקסט / לינק / תמונה / הודעה קולית — נשמר אוטומטית\n• "תשמור את זה למאוחר יותר" → /queue\n\n<b>שליפה</b>\n• שאל שאלה ואענה מתוך הנוטות שלך\n• /search [מילות חיפוש] — חיפוש ישיר\n• /report — סיכום שבועי של מה שנשמר\n\n<b>יומן ותזכורות</b>\n• תוכן רגשי → נשמר ביומן אוטומטית\n• "תזכיר לי X בעוד שעה / מחר" — /reminders לרשימה\n\n<b>כלים נוספים</b>\n• /html [תיאור] — יצירת artifact / ממשק\n• "צור תמונה של..." — יצירת תמונה\n• "חפש ברשת..." — חיפוש עדכני\n• "תכין מתכון של..." — שמירת מתכון\n• /export — ייצוא כל הנוטות\n• /delete — מחיקת נוטה`
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, bio, 'HTML')
      return
    }

    const isRecentQuery = q.includes('אחרון') || q.includes('אחרונה') || q.includes('לאחרונה') || q.includes('recently') || q.includes('last saved')
    if (isRecentQuery) {
      const recent = await getRecentNotes(siteUrl, 5)
      if (recent.length) {
        const lines = ['🕐 <b>הדברים האחרונים שנשמרו:</b>', '']
        recent.forEach(n => lines.push(`• <a href="${siteUrl}/${n.slug}">${escapeHtmlTg(n.title)}</a>`))
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML')
      } else {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'עדיין לא נשמרו נוטות.')
      }
      return
    }

    // ── Send thinking indicator immediately (perceived latency) ─────
    await sendTyping(env.TELEGRAM_BOT_TOKEN, message.chat.id)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '🧠 מחשב...')

    // ── Load history + expand query bilingually — in parallel ────────
    const chatId = message.chat.id
    const [history, bilingualQuery] = await Promise.all([
      loadHistory(chatId, env),
      expandQueryBilingually(question, env),
    ])
    const recentCtx = history.slice(-4).map(h => h.content).join(' ')
    const expandedQuery = `${bilingualQuery} ${recentCtx}`.slice(0, 2000)

    const notes = await retrieveRelevantNotes(expandedQuery, history, siteUrl, env)
    const noteContext = notes.length
      ? notes.map((n, i) => `[Note ${i + 1}] "${n.title}"\n${n.content.slice(0, 1200)}`).join('\n\n---\n\n')
      : null

    const isHebrew = /[֐-׿]/.test(question)

    // Load memory profile from GitHub (best-effort, don't block on failure)
    let memoryProfile = null
    try {
      const profileRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO || 'your-github-username/your-repo-name'}/contents/content/memory/profile.md?ref=${env.GITHUB_BRANCH || 'main'}`,
        { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } }
      )
      if (profileRes.ok) {
        const data = await profileRes.json()
        const raw = decodeGithubContent(data.content)
        memoryProfile = raw.replace(/^---[\s\S]*?---\n?/, '').trim()
      }
    } catch {}

    const systemPrompt = [
      `You are the user's personal second brain assistant.`, // TODO: add a line here about who you are if you want the assistant to have that context
      `The brain site is at: ${siteUrl}`,
      `Today's date: ${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
      memoryProfile
        ? `\nUser's Memory Profile (use this to personalize answers and make connections to their interests):\n${memoryProfile}`
        : '',
      isHebrew
        ? `IMPORTANT: The user asked in Hebrew — you MUST respond entirely in Hebrew. Do not switch to English.`
        : `Respond in the same language the user used. Be concise and direct.`,
      noteContext
        ? `\nUse the following saved notes to answer (cite with [Note N]):\n\nNOTES:\n${noteContext}`
        : `\nNo relevant notes were found for this query. IMPORTANT: Do NOT invent, guess, or use outside knowledge about specific people, products, or companies. Simply say you found no saved notes on this topic and suggest the user save something about it.`,
    ].filter(Boolean).join('\n')

    // Use 8B for short simple queries (3-4x faster), 70B for complex ones
    const isComplex = question.length > 120 || notes.length > 2 || history.length > 4
      || /נתח|השווה|סכם|כתוב|תסביר|analyze|compare|summarize|write|explain/i.test(question)
    const model = isComplex
      ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      : '@cf/meta/llama-3.1-8b-instruct'
    const r = await env.AI.run(model, {
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
      ],
      max_tokens: isComplex ? 700 : 400,
    })
    const answer = r.response?.trim() || '⚠️ המודל לא החזיר תשובה.\n\n💡 נסה לנסח את השאלה קצר יותר, או שאל שאלה אחרת.'

    await saveHistory(chatId, [
      ...history,
      { role: 'user', content: question, ts: Date.now() },
      { role: 'assistant', content: answer, ts: Date.now() },
    ], env)

    const lines = [`🧠 ${answer}`]
    if (notes.length) {
      lines.push('', `📚 <i>מתוך הנוטות שלך:</i>`)
      notes.slice(0, 3).forEach(n => lines.push(`  • <a href="${siteUrl}/${n.slug}">${escapeHtmlTg(n.title)}</a>`))
    }
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML')
  } catch (err) {
    console.error('handleTelegramQuery error:', err)
    const msg = err.message || ''
    let userMsg
    if (msg.includes('GitHub') || msg.includes('github') || msg.includes('403') || msg.includes('401'))
      userMsg = '❌ <b>בעיית גישה ל-GitHub</b>\n\nה-token כנראה פג תוקף או שגוי.\n💡 <i>פתח Claude Code ואמור לו: "ה-GitHub token של הבוט נכשל, צריך לעדכן"</i>'
    else if (msg.includes('AI') || msg.includes('model') || msg.includes('llama') || msg.includes('overloaded'))
      userMsg = '❌ <b>מודל ה-AI עמוס</b>\n\n💡 נסה שוב בעוד כ-30 שניות, או נסח את השאלה קצר יותר.'
    else if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout'))
      userMsg = '❌ <b>בעיית רשת</b>\n\n💡 נסה שוב. אם חוזר — פתח Claude Code ואמור "הבוט מחזיר timeout על שאילתות".'
    else
      userMsg = `❌ <b>שגיאה לא צפויה</b>\n\n<code>${escapeHtmlTg(msg.slice(0, 150))}</code>\n\n💡 העתק את ההודעה הזו ל-Claude Code לאבחון.`
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, userMsg, 'HTML')
  }
}

// ── Auth ──────────────────────────────────────────────────────────────
export async function handleAuth(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const rlKey = `ratelimit:auth:${ip}`
  try {
    const rl = await env.BRAIN_KV.get(rlKey, 'json') || { attempts: 0, blockedUntil: 0 }
    if (rl.blockedUntil > Date.now()) {
      const mins = Math.ceil((rl.blockedUntil - Date.now()) / 60000)
      return jsonResponse({ error: `Too many attempts. Try again in ${mins} minute(s).` }, 429)
    }
    const { passphrase } = await request.json()
    const secret = env.CHAT_PASSPHRASE || env.SITE_PASSPHRASE
    if (!secret || passphrase !== secret) {
      const attempts = (rl.attempts || 0) + 1
      const blockedUntil = attempts >= 10 ? Date.now() + 15 * 60 * 1000 : 0
      await env.BRAIN_KV.put(rlKey, JSON.stringify({ attempts, blockedUntil }), { expirationTtl: 900 })
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }
    await env.BRAIN_KV.delete(rlKey)
    const token = crypto.randomUUID()
    await env.BRAIN_KV.put(`session:${token}`, '1', { expirationTtl: SESSION_TTL_SECONDS })
    return jsonResponse({ token })
  } catch {
    return jsonResponse({ error: 'Bad Request' }, 400)
  }
}

// Accepts token (web) or passphrase (CLI/backfill). Token is preferred.
export async function authRequest(request, env) {
  const token = request.headers.get('X-Chat-Token')
  if (token) {
    const val = await env.BRAIN_KV.get(`session:${token}`)
    return val !== null
  }
  const pass = request.headers.get('X-Chat-Passphrase')
  const secret = env.CHAT_PASSPHRASE || env.SITE_PASSPHRASE
  return Boolean(secret && pass === secret)
}

// ── Note CRUD endpoints (web edit/delete) ─────────────────────────────
export function authPassphrase(request, env) {
  const pass = request.headers.get('X-Chat-Passphrase')
  const secret = env.CHAT_PASSPHRASE || env.SITE_PASSPHRASE
  return secret && pass === secret
}

export async function handleNoteGet(request, env) {
  if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
  const url = new URL(request.url)
  const slug = sanitizeSlug(url.searchParams.get('slug') || '')
  if (!slug) return jsonResponse({ error: 'Invalid slug' }, 400)
  try {
    const branch = env.GITHUB_BRANCH || 'main'
    const path = `content/${slug}.md`
    const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${branch}`
    const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } })
    if (res.status === 404) return jsonResponse({ error: 'Not found' }, 404)
    if (!res.ok) return jsonResponse({ error: `GitHub ${res.status}` }, 502)
    const data = await res.json()
    const content = decodeGithubContent(data.content)
    return jsonResponse({ slug, path, sha: data.sha, content })
  } catch (err) {
    console.error('handleNoteGet error:', err)
    return jsonResponse({ error: String(err) }, 500)
  }
}

export async function handleNoteUpdate(request, env) {
  if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
  try {
    const { slug: rawSlug, content } = await request.json()
    const slug = sanitizeSlug(rawSlug)
    if (!slug) return jsonResponse({ error: 'Invalid slug' }, 400)
    if (typeof content !== 'string') return jsonResponse({ error: 'Missing content' }, 400)

    const path = `content/${slug}.md`
    // Write the new content (commitFile resolves SHA when not isNew)
    await commitFile(path, content, `edit: ${slug}`, env, false, false)

    // Re-embed for vector search using the body (skip frontmatter)
    const bodyOnly = content.replace(/^---[\s\S]*?---\n?/, '')
    const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m)
    const title = titleMatch ? titleMatch[1].trim() : slug

    // Background tasks: re-index + redeploy in parallel
    await Promise.all([
      upsertVector(slug, [title, bodyOnly].join(' ').slice(0, 8000), { title }, env),
      triggerDeploy(env),
    ])

    return jsonResponse({ ok: true, slug, title })
  } catch (err) {
    console.error('handleNoteUpdate error:', err)
    return jsonResponse({ error: String(err) }, 500)
  }
}

export async function handleNoteDelete(request, env) {
  if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
  try {
    const { slug: rawSlug } = await request.json()
    const slug = sanitizeSlug(rawSlug)
    if (!slug) return jsonResponse({ error: 'Invalid slug' }, 400)

    // Remove the note's chunks from Supabase so it drops out of search at once.
    await deleteChunksByNote(slug, env)

    // Find attachment references inside the note before deletion (best-effort cleanup)
    const branch = env.GITHUB_BRANCH || 'main'
    const notePath = `content/${slug}.md`
    let referencedAttachments = []
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${notePath}?ref=${branch}`,
        { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } },
      )
      if (ghRes.ok) {
        const data = await ghRes.json()
        const md = decodeGithubContent(data.content)
        const matches = [...md.matchAll(/attachments\/([^\s\])"|]+)/g)]
        referencedAttachments = [...new Set(matches.map(m => `content/attachments/${m[1]}`))]
      }
    } catch {}

    const noteDeleted = await deleteGithubFile(notePath, env)
    const attachmentResults = await Promise.allSettled(referencedAttachments.map(p => deleteGithubFile(p, env)))
    const attachmentsDeleted = attachmentResults.filter(r => r.status === 'fulfilled' && r.value).length

    await triggerDeploy(env)
    return jsonResponse({ ok: noteDeleted, slug, noteDeleted, attachmentsDeleted })
  } catch (err) {
    console.error('handleNoteDelete error:', err)
    return jsonResponse({ error: String(err) }, 500)
  }
}

// ── Web chat ──────────────────────────────────────────────────────────
export async function handleChat(request, env) {
  try {
    if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
    const { message, history = [], attachment } = await request.json()
    if (!message && !attachment) return jsonResponse({ error: 'Missing message or attachment' }, 400)
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const userText = message || (attachment ? `What can you tell me about this ${attachment.kind}?` : '')

    if (attachment && attachment.kind === 'video' && attachment.dataUrl) {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ answer: "⚠️ Video analysis requires GEMINI_API_KEY to be configured on the Worker.", sources: [], canSave: false })
      }
      try {
        const base64 = attachment.dataUrl.split(',')[1] || ''
        const bytes = base64ToBytes(base64)
        const analysis = await analyzeVideoContent({
          platform: 'upload',
          videoBytes: bytes.buffer,
          videoMime: attachment.mime || 'video/mp4',
          userNote: userText,
        }, env)
        if (!analysis) {
          return jsonResponse({ answer: "❌ Couldn't analyze the video. The file may be too long or in an unsupported format.", sources: [], canSave: false })
        }
        const previewLines = []
        if (analysis.summary) previewLines.push(`📝 ${analysis.summary}`)
        if (analysis.whySaved) previewLines.push('', `🎯 ${analysis.whySaved}`)
        if (analysis.keyPoints?.length) {
          previewLines.push('', '🔑 Key points:')
          analysis.keyPoints.forEach(p => previewLines.push(`  • ${p}`))
        }
        if (analysis.duration) previewLines.push('', `⏱ Duration: ${analysis.duration}`)
        return jsonResponse({
          answer: previewLines.join('\n'),
          sources: [],
          canSave: true,
          videoAnalysis: analysis,
          attachmentEcho: summarizeAttachment(attachment),
        })
      } catch (err) {
        console.error('Chat video error:', err)
        return jsonResponse({ answer: `❌ Video analysis failed: ${err.message}`, sources: [], canSave: false })
      }
    }

    if (attachment && attachment.kind === 'image' && attachment.dataUrl) {
      const base64 = attachment.dataUrl.split(',')[1] || ''
      const bytes = base64ToBytes(base64)
      try {
        const vision = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
          image: [...bytes],
          prompt: `You are the user's second brain. Look at this image and answer their question concisely.\n\nQuestion: ${userText}`,
          max_tokens: 512,
        })
        const answer = (vision.description || '').trim() || "I can see the image but couldn't generate a description."
        return jsonResponse({ answer, sources: [], canSave: true, attachmentEcho: summarizeAttachment(attachment) })
      } catch (err) {
        console.error('Vision error:', err)
        return jsonResponse({ answer: `❌ Vision error: ${err.message}`, sources: [], canSave: true })
      }
    }

    let attachmentContext = ''
    if (attachment && attachment.text) {
      const clipped = attachment.text.slice(0, 8000)
      attachmentContext = `\n\nATTACHED FILE (${attachment.name}, ${attachment.kind}):\n"""\n${clipped}\n"""\n`
    }

    const notes = await retrieveRelevantNotes(userText + ' ' + (attachment?.text || '').slice(0, 500), history, siteUrl, env)
    const noteContext = notes.length
      ? notes.map((n, i) => `[Note ${i + 1}] "${n.title}" (${n.slug})\n${n.content.slice(0, 1200)}`).join('\n\n---\n\n')
      : 'No relevant notes found in the knowledge base.'

    const systemPrompt = `You are the user's second brain — a personal AI assistant with access to their knowledge base and any file they've attached.

Be concise, useful, speak in whichever language the user uses (English or Hebrew).

When answering:
- If a file is attached, focus on it first and cite exact snippets.
- If notes are relevant, cite them using [Note N] syntax.
- Be direct. No corporate fluff.

NOTES FROM YOUR SECOND BRAIN:
${noteContext}${attachmentContext}`

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userText },
    ]
    const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, max_tokens: 800 })
    const answer = aiResponse.response || "Sorry, I couldn't generate a response."

    const citedIndices = [...answer.matchAll(/\[Note (\d+)\]/g)].map(m => parseInt(m[1]) - 1)
    const cited = [...new Set(citedIndices)].filter(i => i >= 0 && i < notes.length).map(i => ({ title: notes[i].title, url: `${siteUrl}/${notes[i].slug}` }))
    const sources = cited.length ? cited : notes.slice(0, 3).map(n => ({ title: n.title, url: `${siteUrl}/${n.slug}` }))

    return jsonResponse({ answer, sources, canSave: !!attachment, attachmentEcho: attachment ? summarizeAttachment(attachment) : null })
  } catch (err) {
    console.error('Chat error:', err)
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500)
  }
}

export function summarizeAttachment(a) { return { name: a.name, kind: a.kind, mime: a.mime, size: a.size } }

// ── Save from chat ────────────────────────────────────────────────────
export async function handleSave(request, env) {
  try {
    if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
    const { message, answer, attachment, videoAnalysis } = await request.json()
    if (!attachment) return jsonResponse({ error: 'Missing attachment' }, 400)

    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]
    const slug = `${dateStr}-${now.getTime()}`
    const safeName = (attachment.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
    const assetPath = `content/attachments/${slug}-${safeName}`

    // ── Video attachment: full pipeline (reuse analysis if passed) ──
    if (attachment.kind === 'video' && attachment.dataUrl) {
      return await handleSaveVideo({ request, env, message, answer, attachment, videoAnalysis, slug, dateStr, safeName, assetPath })
    }

    let assetRef = ''
    let assetCommitPromise = null
    if (attachment.dataUrl) {
      const base64 = attachment.dataUrl.split(',')[1] || ''
      const bytes = base64ToBytes(base64)
      // Fire-and-forget the asset commit; we'll await it in parallel with the note commit below
      assetCommitPromise = commitFile(assetPath, bytes.buffer, `Attach ${safeName}`, env, true, true)
      assetRef = `attachments/${slug}-${safeName}`
    }

    const aiResult = await analyzeAttachment({ message, answer, attachment }, env)
    const allTags = [...new Set(['inbox', 'chat', attachment.kind, ...aiResult.tags])]

    const body = []
    if (attachment.kind === 'image' && assetRef) body.push(`![[${assetRef}]]`, '')
    else if (assetRef) body.push(`📎 [[${assetRef}|${safeName}]]`, '')
    if (aiResult.summary) body.push(`> ${aiResult.summary}`, '')
    if (aiResult.whySaved) body.push(`**Why saved:** ${aiResult.whySaved}`, '')
    if (aiResult.whenToApply) body.push(`**When to apply:** ${aiResult.whenToApply}`, '')
    if (message) body.push(`**My question:** ${message}`, '')
    if (answer) body.push(`**Brain's answer:**`, '', answer, '')
    if (attachment.text) {
      const preview = attachment.text.slice(0, 2000)
      body.push('---', '', `**Extracted text${attachment.text.length > 2000 ? ' (first 2000 chars)' : ''}:**`, '', '```', preview, '```', '')
    }

    const frontmatter = [
      '---',
      `title: "${(aiResult.title || safeName).replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: chat`,
      `kind: ${attachment.kind}`,
      aiResult.whenToApply ? `when_to_apply: "${aiResult.whenToApply.replace(/"/g, "'")}"` : '',
      '---',
    ].filter(Boolean).join('\n')

    const noteSlug = `inbox/${slug}`
    const fullContent = frontmatter + '\n\n' + body.join('\n') + '\n'
    // Run asset commit (if any) + note commit in parallel
    await Promise.all([
      assetCommitPromise,
      commitFile(`content/${noteSlug}.md`, fullContent, `Chat save: ${aiResult.title || safeName}`, env, false, true),
    ].filter(Boolean))
    // Activity log + deploy run in parallel — neither blocks the response
    await Promise.all([
      appendActivityLog({ from: 'Chat', kind: attachment.kind, title: aiResult.title || safeName, slug: noteSlug, env }),
      triggerDeploy(env),
    ])

    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    return jsonResponse({
      noteUrl: `${siteUrl}/${noteSlug}`,
      title: aiResult.title || safeName,
      summary: aiResult.summary || '',
      whySaved: aiResult.whySaved || '',
      tags: allTags.filter(t => t !== 'inbox'),
      kind: attachment.kind,
      filename: safeName,
    })
  } catch (err) {
    console.error('Save error:', err)
    return jsonResponse({ error: 'Save failed', detail: String(err) }, 500)
  }
}

// ── Save chat answer as a synthesis page (Karpathy LLM-Wiki pattern) ──
// POST /synthesis/save  { question, answer, sources: [{ title, url }, ...] }
// Files content/notes/synthesis/YYYY-MM-DD-{slug}.md and returns siteUrl.
export async function handleSynthesisSave(request, env) {
  try {
    if (!await authRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
    const { question, answer, sources } = await request.json()
    if (!question || !answer) return jsonResponse({ error: 'Missing question or answer' }, 400)

    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]
    // Slugify question to ASCII-safe kebab-case, max 60 chars.
    const baseSlug = (question || 'synthesis')
      .toLowerCase()
      .replace(/[֐-׿]+/g, '')        // strip Hebrew (filename safety; title preserves it)
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'synthesis'
    const filename = `${dateStr}-${baseSlug}-${now.getTime().toString().slice(-5)}`
    const noteSlug = `notes/synthesis/${filename}`
    const notePath = `content/${noteSlug}.md`

    // Convert source URLs that point back to this site into wikilinks; keep external as plain links.
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const sourceLines = (sources || []).slice(0, 10).map(s => {
      try {
        const u = new URL(s.url, siteUrl)
        const host = new URL(siteUrl).host
        if (u.host === host) {
          const slug = u.pathname.replace(/^\/+/, '').replace(/\.html?$/, '').replace(/\/$/, '')
          return slug ? `- [[${slug}|${s.title || slug}]]` : `- [${s.title || u.href}](${u.href})`
        }
        return `- [${s.title || u.href}](${u.href})`
      } catch {
        return `- ${s.title || s.url || ''}`
      }
    })

    const safeTitle = (question.length > 80 ? question.slice(0, 77) + '…' : question).replace(/"/g, "'")
    const frontmatter = [
      '---',
      `title: "${safeTitle}"`,
      `date: ${dateStr}`,
      `updated: ${dateStr}`,
      `tags: ["synthesis", "chat"]`,
      `source: synthesis`,
      `sources: [${(sources || []).map(s => `"${(s.url || '').replace(/"/g, '\\"')}"`).join(', ')}]`,
      '---',
    ].join('\n')

    const body = [
      `## Question`,
      ``,
      question,
      ``,
      `## Synthesis`,
      ``,
      answer,
      ``,
      ...(sourceLines.length ? [`## Sources`, ``, ...sourceLines, ``] : []),
    ].join('\n')

    const fullContent = frontmatter + '\n\n' + body

    await commitFile(notePath, fullContent, `synth: ${safeTitle}`, env, false, true)
    // Best-effort activity log + deploy trigger (don't block on failure)
    try {
      await Promise.all([
        appendActivityLog({ from: 'Chat', kind: 'synthesis', title: safeTitle, slug: noteSlug, env }),
        triggerDeploy(env),
      ])
    } catch {}

    return jsonResponse({
      noteUrl: `${siteUrl}/${noteSlug}`,
      title: safeTitle,
      slug: noteSlug,
    })
  } catch (err) {
    console.error('Synthesis save error:', err)
    return jsonResponse({ error: 'Synthesis save failed', detail: String(err) }, 500)
  }
}

// ── Activity log (with SHA-conflict retry) ────────────────────────────
export async function appendActivityLog({ from, kind, title, slug, env }) {
  try {
    const branch = env.GITHUB_BRANCH || 'main'
    const path = 'content/activity.md'
    const putUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`
    const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot', 'Content-Type': 'application/json' }

    for (let attempt = 0; attempt < 3; attempt++) {
      const check = await fetch(`${putUrl}?ref=${branch}`, { headers: ghHeaders })
      let current = ''
      let sha
      if (check.ok) {
        const data = await check.json()
        sha = data.sha
        current = decodeGithubContent(data.content)
      } else {
        current = `---\ntitle: Activity Log\ntags: ["meta"]\n---\n\n# Activity\n\nAll captures to your Brain — newest first. Auto-generated by the bot.\n\n<!-- ACTIVITY_LOG_START -->\n| When | From | Kind | Title | Link |\n|------|------|------|-------|------|\n<!-- ACTIVITY_LOG_END -->\n`
      }
      const when = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16)
      const safeTitle = String(title || '(untitled)').replace(/\|/g, '\\|').slice(0, 80)
      const row = `| ${when} | ${from} | ${kind} | ${safeTitle} | [→](/${slug}) |`
      const marker = '|------|------|------|-------|------|'
      const next = current.includes(marker)
        ? current.replace(marker, `${marker}\n${row}`)
        : current + `\n${row}\n`

      const bytes = new TextEncoder().encode(next)
      let binary = ''; for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
      const putBody = { message: `log: ${kind} from ${from}`, content: encodeGithubContent(next), branch, committer: GIT_IDENTITY, author: GIT_IDENTITY }
      if (sha) putBody.sha = sha
      const res = await fetch(putUrl, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putBody) })
      if (res.ok) return
      if (res.status === 409) continue // SHA conflict — retry with fresh SHA
      console.error('activity log failed:', await res.text())
      return
    }
  } catch (err) {
    console.error('appendActivityLog error:', err)
  }
}

export async function handleGenerateArtifact(message, env) {
  const chatId = message.chat.id
  const prompt = (message.text || '')
    .replace(/^\/html\s*/i, '')
    .replace(/^(תכין|תיצור|תבנה|תעשה|צור|בנה|עשה|יצור|הכן)\s*(לי\s*)?/i, '')
    .replace(/^(create|build|make|generate)\s*(me\s*)?/i, '')
    .trim()
  if (!prompt) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❓ Usage: /html <description>\nExample: /html dashboard of my inbox notes this week')
    return
  }
  const thinkingMsgId = await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🎨 יוצר HTML...')
  try {
    // Retrieve relevant notes from knowledge base
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const notes = await retrieveRelevantNotes(prompt, [], siteUrl, env).catch(() => [])
    const noteContext = notes.length
      ? notes.map((n, i) => `[Note ${i + 1}] "${n.title}"\n${n.content.slice(0, 1500)}`).join('\n\n---\n\n')
      : null
    const enrichedPrompt = noteContext
      ? `${prompt}\n\n---\nRelevant notes from my knowledge base:\n${noteContext}`
      : prompt
    let html = await generateHtmlWithGemini(enrichedPrompt, null, env)
    if (!html) html = await generateHtmlWithCfAI(enrichedPrompt, null, env)
    if (!html) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ לא הצלחתי לייצר HTML. נסה שוב עם תיאור מפורט יותר.')
      return
    }
    const ts = new Date(message.date * 1000)
    const slug = `${ts.toISOString().split('T')[0]}-${ts.getTime()}`
    const path = `quartz/static/artifacts/${slug}.html`
    const artifactUrl = `${siteUrl}/static/artifacts/${slug}.html`
    await commitFile(path, html, `artifact: ${prompt.slice(0, 60)}`, env, false, true)
    const filename = `${slug}.html`
    const replyMsgId = await sendTelegramDocument(env.TELEGRAM_BOT_TOKEN, chatId, filename, html,
      `📄 <b>${prompt.slice(0, 60)}</b>`)
        if (env.BRAIN_KV) {
      await env.BRAIN_KV.put(
        `artifact:${chatId}`,
        JSON.stringify({ slug, url: artifactUrl, path, prompt, replyMsgId }),
        { expirationTtl: 604800 }
      )
    }
  } catch (err) {
    console.error('handleGenerateArtifact error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `❌ שגיאה: ${err.message}`)
  }
}

export async function handleEditArtifact(message, env) {
  const chatId = message.chat.id
  const editRequest = (message.text || '').replace(/^\/edit\s*/i, '').trim()
  if (!editRequest) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❓ Usage: /edit <what to change>\nExample: /edit add a dark mode toggle')
    return
  }
  const artifactData = env.BRAIN_KV ? await env.BRAIN_KV.get(`artifact:${chatId}`, 'json') : null
  if (!artifactData) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❓ אין HTML אחרון לערוך. השתמש ב-/html כדי ליצור אחד קודם.')
    return
  }
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '✏️ מעדכן HTML...')
  try {
    const branch = env.GITHUB_BRANCH || 'main'
    const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${artifactData.path}?ref=${branch}`
    const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } })
    if (!res.ok) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ לא מצאתי את ה-HTML. ייתכן שנמחק.')
      return
    }
    const fileData = await res.json()
    const currentHtml = decodeGithubContent(fileData.content)
    let updatedHtml = await generateHtmlWithGemini(editRequest, currentHtml, env)
    if (!updatedHtml) updatedHtml = await generateHtmlWithCfAI(editRequest, currentHtml, env)
    if (!updatedHtml) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ לא הצלחתי לעדכן. נסה שוב.')
      return
    }
    await commitFile(artifactData.path, updatedHtml, `artifact edit: ${editRequest.slice(0, 60)}`, env, false, true)
    await sendTelegram(
      env.TELEGRAM_BOT_TOKEN, chatId,
      `✅ <b>עודכן!</b>\n\n🔗 <a href="${artifactData.url}">${artifactData.url}</a>\n\n⏳ <i>יהיה חי בעוד ~2 דקות</i>`,
      'HTML'
    )
  } catch (err) {
    console.error('handleEditArtifact error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `❌ שגיאה: ${err.message}`)
  }
}

// ── Conversation history via Cloudflare KV ────────────────────────────
export async function loadHistory(chatId, env) {
  if (!env.BRAIN_KV) return []
  try {
    const data = await env.BRAIN_KV.get(`chat:${chatId}`, 'json')
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

export async function saveHistory(chatId, history, env) {
  if (!env.BRAIN_KV) return
  try {
    await env.BRAIN_KV.put(`chat:${chatId}`, JSON.stringify(history.slice(-20)), { expirationTtl: 604800 })
  } catch {}
}

// ── Conversational handler — answers questions using notes + history ───
export async function handleConversation(message, env) {
  const chatId = message.chat.id
  const userText = (message.text || '').trim()
  const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'

  const history = await loadHistory(chatId, env)

  // Expand query with recent context for better retrieval
  const recentCtx = history.slice(-4).map(h => h.content).join(' ')
  const expandedQuery = `${userText} ${recentCtx}`.slice(0, 2000)

  const notes = await retrieveRelevantNotes(expandedQuery, history, siteUrl, env)
  const noteContext = notes.length
    ? notes.map((n, i) => `[Note ${i + 1}] "${n.title}"\n${n.content.slice(0, 1000)}`).join('\n\n---\n\n')
    : null

  const systemPrompt = [
    `You are the user's second brain — a personal AI assistant with access to their saved knowledge base.`, // TODO: add a line here about who you are if you want the assistant to have that context
    `Today: ${new Date().toLocaleDateString('en-US', { timeZone: 'UTC' })}`, // TODO: set your own locale/timezone
    `Respond in the same language the user uses. Be concise and direct. No fluff.`,
    `If citing a note, use [Note N] syntax. If no notes are relevant, say so and answer from general knowledge.`,
    noteContext
      ? `\nNOTES FROM YOUR SECOND BRAIN:\n${noteContext}`
      : `\nNo relevant notes found for this topic.`,
  ].join('\n')

  const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userText },
    ],
    max_tokens: 700,
  })
  const answer = r.response || 'לא מצאתי תשובה.'

  await saveHistory(chatId, [
    ...history,
    { role: 'user', content: userText, ts: Date.now() },
    { role: 'assistant', content: answer, ts: Date.now() },
  ], env)

  const lines = [`🧠 ${answer}`]
  if (notes.length) {
    lines.push('', `📚 <i>מתוך הנוטות שלך:</i>`)
    notes.slice(0, 3).forEach(n => lines.push(`  • <a href="${siteUrl}/${n.slug}">${escapeHtmlTg(n.title)}</a>`))
  }
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, lines.join('\n'), 'HTML')
}

// ── Telegram: save flow ───────────────────────────────────────────────
export async function processMessage(message, env, opts = {}) {
  try {
    const { ctx, skipClassifier } = opts
    const { text, caption, photo, document, entities, caption_entities, date } = message
    const rawContent = text || caption || ''
    const allEntities = entities || caption_entities || []
    const urls = extractUrls(rawContent, allEntities)
    const userNote = rawContent.replace(/https?:\/\/[^\s]+/g, '').replace(/#\w+/g, '').trim()
    const hashtags = [...rawContent.matchAll(/#(\w+)/g)].map(m => m[1].toLowerCase())

    // ── Duplicate URL detection ────────────────────────────────────────
    if (urls.length > 0 && !opts.skipDuplicateCheck && env.BRAIN_KV) {
      for (const url of urls) {
        const existing = await env.BRAIN_KV.get(`url_idx:${simpleHash(url)}`, 'json')
        if (existing) {
          const pendingId = crypto.randomUUID().slice(0, 8)
          await env.BRAIN_KV.put(`pending:${pendingId}`, JSON.stringify(message), { expirationTtl: 300 })
          const markup = { inline_keyboard: [[
            { text: '🔗 פתח', url: existing.noteUrl },
            { text: '💾 שמור שוב', callback_data: `save_anyway:${pendingId}` },
          ]]}
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id,
            `♻️ <b>כבר שמרת את הלינק הזה:</b>\n<i>${escapeHtmlTg(existing.title || url)}</i>`,
            'HTML', markup)
          return
        }
      }
    }

    // ── Document path: PDF, text, code, etc. — always save, skip classifier ──
    if (document) {
      const ts = new Date(date * 1000)
      const dStr = ts.toISOString().split('T')[0]
      const slg = `${dStr}-${ts.getTime()}`
      return await processDocumentMessage({ message, env, slug: slg, dateStr: dStr, userNote, hashtags, ctx })
    }

    // Intent already classified upstream by routeIntent. processMessage's job
    // is purely the SAVE path now — no more internal classification.

    await sendTyping(env.TELEGRAM_BOT_TOKEN, message.chat.id)

    const timestamp = new Date(date * 1000)
    const dateStr = timestamp.toISOString().split('T')[0]
    const slug = `${dateStr}-${timestamp.getTime()}`
    const richUrls = await Promise.all(urls.map(url => fetchRichMeta(url, env)))

    // ── Video URL path: run full Gemini analysis when a video platform is detected ──
    const primaryUrl = urls[0]
    const videoPlatform = primaryUrl ? detectVideoPlatform(primaryUrl) : null
    if (videoPlatform && env.GEMINI_API_KEY) {
      const handled = await processVideoMessage({
        message, env, slug, dateStr, userNote, hashtags, ctx,
        url: primaryUrl, platform: videoPlatform,
        existingMeta: richUrls[0] || {},
      })
      if (handled) return
      // else: fall through to metadata-only path below
    }

    // ── If URL-only and we couldn't extract content, try Jina Reader then fall back to stub ──
    const hasRealUrlContent = richUrls.some(r => (r.description && r.description.length > 30) || (r.title && r.title.length > 10 && r.title.toLowerCase() !== 'facebook' && r.title.toLowerCase() !== 'instagram' && r.title.toLowerCase() !== 'twitter' && r.title.toLowerCase() !== 'x'))
    if (!userNote && !photo && urls.length > 0 && !hasRealUrlContent) {
      const domain = (() => { try { return new URL(urls[0]).hostname.replace('www.','') } catch { return 'link' } })()

      // Try Jina Reader API for clean markdown extraction (zero dependencies, works in Workers)
      let extractedContent = ''
      let extractedTitle = ''
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${urls[0]}`, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
          signal: AbortSignal.timeout(8000),
        })
        if (jinaRes.ok) {
          const md = await jinaRes.text()
          const titleMatch = md.match(/^Title:\s*(.+)$/m)
          extractedTitle = titleMatch?.[1]?.trim() || ''
          const contentStart = md.indexOf('Markdown Content:')
          extractedContent = (contentStart > -1
            ? md.slice(contentStart + 'Markdown Content:'.length)
            : md
          ).trim().slice(0, 3000)
        }
      } catch { /* silent — fall through to stub */ }

      if (extractedContent) {
        // Rich note — promote pipeline has content immediately, no user follow-up needed
        const titleLine = extractedTitle ? `title: "${extractedTitle.replace(/"/g, "'")}"\n` : ''
        const richNote = `---\ntags: [inbox, telegram, link]\ndate: ${dateStr}\nsource: ${urls[0]}\n${titleLine}---\n\n${extractedTitle ? `# ${extractedTitle}\n\n` : ''}${extractedContent}\n`
        await commitFile(`content/inbox/${slug}.md`, richNote, `inbox: link from ${domain}`, env, false, true)
        await sendTelegram(
          env.TELEGRAM_BOT_TOKEN,
          message.chat.id,
          `🔗 <b>שמרתי את הלינק</b> ✨\n<i>${escapeHtmlTg(extractedTitle || urls[0])}</i>`,
          'HTML'
        )
      } else {
        // Fallback: stub note — ask user for context.
        // status: pending-context tells promote.mjs to skip this file until
        // the user replies and handleStubContextReply removes the status.
        const stubNote = `---\ntags: [inbox, telegram, link]\ndate: ${dateStr}\nsource: ${urls[0]}\nstatus: pending-context\n---\n\n${urls[0]}\n`
        await commitFile(`content/inbox/${slug}.md`, stubNote, `inbox: link from ${domain}`, env, false, true)
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chat.id,
            text: `🔗 <b>שמרתי את הלינק</b>\n\n💡 על מה הפוסט? (שלח תשובה קצרה)`,
            parse_mode: 'HTML',
            reply_markup: { force_reply: true, input_field_placeholder: 'למשל: פוסט של פלוני על AI agents...' },
          }),
        })
      }
      return
    }

    let imageMarkdown = ''
    let imageVision = { text: '', description: '', source: '', author: '' }
    if (photo) {
      const fileId = photo[photo.length - 1].file_id
      const fileUrl = await getTelegramFileUrl(fileId, env.TELEGRAM_BOT_TOKEN)
      if (fileUrl) {
        const resp = await fetch(fileUrl)
        const buffer = await resp.arrayBuffer()
        const ext = fileUrl.includes('.png') ? 'png' : 'jpg'
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
        const imagePath = `content/attachments/${slug}.${ext}`
        imageMarkdown = `![[attachments/${slug}.${ext}]]`
        try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '👁 מנתח תמונה...') } catch {}
        // Run image commit + vision in parallel — both only need the buffer
        const [, vision] = await Promise.all([
          commitFile(imagePath, buffer, `Add image ${slug}`, env, true, true),
          extractImageContent(buffer, mimeType, env),
        ])
        imageVision = vision

        // Auto-detect recipe from image text
        if (!opts.skipClassifier && imageVision.text && await aiDetectRecipe(imageVision.text + ' ' + userNote, env)) {
          return handleRecipeEntry({ ...message, _visionText: imageVision.text }, env)
        }
      }
    }

    const aiResult = await analyzeWithAI({ userNote, hashtags, richUrls, hasImage: !!photo, imageVision }, env)
    const tgKind = photo ? 'image' : (richUrls.length ? (richUrls[0].type === 'video' ? 'video' : richUrls[0].type === 'repo' ? 'repo' : 'link') : 'text')
    const repoTopics = richUrls.flatMap(r => r.topics || []).map(t => t.replace(/[^a-z0-9-]/gi, '').toLowerCase()).filter(Boolean)
    const allTags = [...new Set(['inbox', 'telegram', tgKind, ...hashtags, ...repoTopics, ...aiResult.tags])]
    const bodyParts = []
    if (imageMarkdown) bodyParts.push(imageMarkdown, '')
    if (aiResult.summary) bodyParts.push(`> ${aiResult.summary}`, '')
    if (imageVision.source || imageVision.author) {
      const meta = [imageVision.source && `**Source:** ${imageVision.source}`, imageVision.author && `**Author:** ${imageVision.author}`].filter(Boolean).join(' · ')
      if (meta) bodyParts.push(meta, '')
    }
    if (imageVision.text) {
      bodyParts.push('## תוכן התמונה', '', imageVision.text, '')
    }
    for (const rich of richUrls) {
      bodyParts.push(`## [${rich.title || rich.url}](${rich.url})`)
      if (rich.author) bodyParts.push(`**By:** ${rich.author}`)
      if (rich.type === 'video' && rich.duration) bodyParts.push(`**Duration:** ${rich.duration}`)
      if (rich.description) bodyParts.push('', rich.description)
      if (rich.keyPoints?.length) { bodyParts.push(''); rich.keyPoints.forEach(p => bodyParts.push(p)) }
      if (rich.readme) bodyParts.push('', '## README', '', rich.readme)
      bodyParts.push('')
    }
    if (userNote) bodyParts.push(`**Note:** ${userNote}`, '')
    if (aiResult.whySaved) bodyParts.push(`**Why saved:** ${aiResult.whySaved}`)
    if (aiResult.whenToApply) bodyParts.push(`**When to apply:** ${aiResult.whenToApply}`)

    const frontmatter = [
      '---',
      `title: "${aiResult.title.replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: telegram`,
      richUrls.length ? `url: "${richUrls[0].url}"` : '',
      richUrls[0]?.type === 'video' ? `type: video` : '',
      aiResult.whenToApply ? `when_to_apply: "${aiResult.whenToApply.replace(/"/g, "'")}"` : '',
      '---',
    ].filter(Boolean).join('\n')

    const fullContent = frontmatter + '\n\n' + bodyParts.join('\n') + '\n'
    // Main note commit blocks the user reply — must succeed before we say "Saved"
    await commitFile(`content/inbox/${slug}.md`, fullContent, `Add: ${aiResult.title}`, env, false, true)

    // Increment memory profile counter; regenerate every 5 notes
    if (env.BRAIN_KV) {
      try {
        const counterVal = await env.BRAIN_KV.get('memory_profile_counter')
        const newCount = (parseInt(counterVal || '0', 10) + 1)
        if (newCount >= 5) {
          await env.BRAIN_KV.put('memory_profile_counter', '0')
          if (ctx) ctx.waitUntil(updateMemoryProfile(env))
        } else {
          await env.BRAIN_KV.put('memory_profile_counter', String(newCount))
        }
      } catch (err) { console.error('memory counter error:', err) }
    }

    const tagLine = allTags.filter(t => t !== 'inbox').join(', ') || 'note'
    const lines = ['✅ <b>Saved to Brain</b>', '', `📝 <b>${escapeHtmlTg(aiResult.title)}</b>`]
    if (aiResult.summary) lines.push('', `💭 ${escapeHtmlTg(aiResult.summary)}`)
    if (aiResult.whySaved) lines.push('', `🎯 <i>Why saved:</i> ${escapeHtmlTg(aiResult.whySaved)}`)
    if (aiResult.whenToApply) lines.push('', `🛠 <i>When to apply:</i> ${escapeHtmlTg(aiResult.whenToApply)}`)
    if (aiResult.keyPoints?.length) {
      lines.push('', '🔑 <i>Key points:</i>')
      aiResult.keyPoints.slice(0, 3).forEach(p => lines.push(`  • ${escapeHtmlTg(p)}`))
    }
    lines.push('', `🏷 ${escapeHtmlTg(tagLine)}`)
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const noteUrl = `${siteUrl}/inbox/${slug}`
    lines.push('', `🔗 <a href="${noteUrl}">Open in Brain</a> <i>(deploying…)</i>`)
    if (env.BOT_USERNAME) {
      const ts = slug.split('-').pop()
      lines.push(`🤖 <a href="https://t.me/${env.BOT_USERNAME}?start=note_${ts}">Share via Bot</a>`)
    }
    const deleteMarkup = { inline_keyboard: [[{ text: '🗑 מחק', callback_data: `del:${slug}` }]] }

    const richBody = richUrls.map(r => [r.title, r.description, r.keyPoints?.join(' ')].filter(Boolean).join(' ')).join(' ')
    const embedText = [
      aiResult.title, aiResult.title,  // double-weight title
      aiResult.summary,
      allTags.join(' '),
      userNote,
      aiResult.keyPoints?.join(' '),
      imageVision.text, imageVision.description,
      richBody,
      bodyParts.join(' ').slice(0, 1500),
    ].filter(Boolean).join(' ').slice(0, 2000)

    // Run user-facing reply + background tasks in parallel.
    // sendTelegram resolves first (~150ms), so user sees ✅ while the rest finish.
    const [msgId] = await Promise.all([
      sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML', deleteMarkup),
      upsertVector(`inbox/${slug}`, embedText, { title: aiResult.title }, env),
      appendActivityLog({ from: 'Telegram', kind: tgKind, title: aiResult.title, slug: `inbox/${slug}`, env }),
      triggerDeploy(env),
    ])
    if (ctx && msgId) {
      const finalText = lines.join('\n').replace(' <i>(deploying…)</i>', '')
      ctx.waitUntil(pollUntilLive(env, message.chat.id, msgId, noteUrl, finalText))
    }
    notifyRelatedNotes(`inbox/${slug}`, aiResult.title, message.chat.id, env).catch(() => {})
    // Index URLs for duplicate detection (fire-and-forget, 1 year TTL)
    if (urls.length > 0 && env.BRAIN_KV) {
      const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
      for (const url of urls) {
        env.BRAIN_KV.put(`url_idx:${simpleHash(url)}`,
          JSON.stringify({ slug: `inbox/${slug}`, title: aiResult.title, noteUrl: `${siteUrl}/inbox/${slug}` }),
          { expirationTtl: 365 * 86400 }
        ).catch(() => {})
      }
    }
  } catch (err) {
    console.error('processMessage error:', err)
    const msg = err.message || ''
    let userMsg
    if (msg.includes('commit failed') || msg.includes('GitHub commit') || msg.includes('422') || msg.includes('409'))
      userMsg = '❌ <b>שמירה ל-GitHub נכשלה</b> (קונפליקט)\n\n💡 נסה לשלוח שוב — בדרך כלל נפתר לבד. אם חוזר, פתח Claude Code ואמור "יש קונפליקט SHA בשמירה לGitHub".'
    else if (msg.includes('403') || msg.includes('401') || msg.includes('token'))
      userMsg = '❌ <b>בעיית הרשאות ל-GitHub</b>\n\nה-token פג תוקף.\n💡 פתח Claude Code ואמור: "צריך לחדש את GITHUB_TOKEN של הבוט".'
    else if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout'))
      userMsg = '❌ <b>בעיית רשת</b> — הנוטה לא נשמרה.\n\n💡 נסה לשלוח שוב. אם חוזר — בדוק חיבור אינטרנט או המתן דקה.'
    else if (msg.includes('AI') || msg.includes('llama') || msg.includes('model'))
      userMsg = '❌ <b>ניתוח התוכן נכשל</b> — הנוטה לא נשמרה.\n\n💡 נסה שוב בעוד דקה. אם חוזר — פתח Claude Code ואמור "מודל ה-AI לא מגיב בעת שמירה".'
    else
      userMsg = `❌ <b>השמירה נכשלה</b>\n\n<code>${escapeHtmlTg(msg.slice(0, 150))}</code>\n\n💡 העתק את ההודעה הזו ל-Claude Code לאבחון.`
    try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, userMsg, 'HTML') } catch {}
  }
}

// ── /search — semantic note search ───────────────────────────────────
export async function handleSearch(message, env) {
  const chatId = message.chat.id
  const query = (message.text || '').replace(/^\/search\s*/i, '').trim()
  if (!query) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🔍 Usage: /search <terms>\nדוגמה: /search RAG pipeline')
    return
  }
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🔍 מחפש...')
  try {
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    // Supabase hybrid search (pgvector + pgroonga) + rerank; dedup chunks → notes.
    const notes = await retrieveRelevantNotes(query, [], siteUrl, env)
    const hits = []
    const seen = new Set()
    for (const n of notes) {
      if (seen.has(n.slug)) continue
      seen.add(n.slug)
      hits.push(n)
    }
    if (!hits.length) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `🔍 לא מצאתי תוצאות עבור: "${escapeHtmlTg(query)}"`, 'HTML')
      return
    }
    const lines = [`📚 <b>${hits.length} תוצאות עבור "${escapeHtmlTg(query)}":</b>`, '']
    hits.forEach((h, i) => {
      lines.push(`${i + 1}. <a href="${siteUrl}/${h.slug}">${escapeHtmlTg(h.title || h.slug)}</a>`)
    })
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, lines.join('\n'), 'HTML')
  } catch (err) {
    console.error('handleSearch error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `❌ חיפוש נכשל: ${err.message}`)
  }
}

// ── /later — read-later queue ─────────────────────────────────────────
export async function handleLater(message, env) {
  const chatId = message.chat.id
  const raw = message.text || message.caption || ''
  const content = raw.replace(/^\/later\s*/i, '').trim()
  if (message.photo || message.document) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
      '⚠️ תמונות ומסמכים לא נתמכים בתור — שלח רק טקסט או לינק עם /later.')
    return
  }
  if (!content) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
      '📥 שלח הודעה עם /later כדי לשמור לתור.\nדוגמה:\n<code>/later https://example.com</code>', 'HTML')
    return
  }
  const ts = Date.now()
  const key = `readlater:${chatId}:${ts}:${crypto.randomUUID().slice(0, 8)}`
  await env.BRAIN_KV.put(key, JSON.stringify({
    text: content || raw,
    originalText: content || raw,
    messageId: message.message_id,
    chatId: String(chatId),
    ts,
  }), { expirationTtl: 30 * 86400 })
  const count = (await env.BRAIN_KV.list({ prefix: `readlater:${chatId}:` })).keys.length
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
    `📥 <b>נשמר לתור!</b> <i>(${count} פריט${count !== 1 ? 'ים' : ''} בסה"כ)</i>\n\nשלח /queue לצפייה ועיבוד.`, 'HTML')
}

export async function handleShowQueue(message, env) {
  const chatId = message.chat.id
  const list = await env.BRAIN_KV.list({ prefix: `readlater:${chatId}:` })
  if (!list.keys.length) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '📭 התור ריק. שלח /later <תוכן> כדי להוסיף.')
    return
  }
  const items = []
  for (const k of list.keys.slice(0, 10)) {
    const val = await env.BRAIN_KV.get(k.name, 'json')
    if (val) items.push({ key: k.name, ...val })
  }
  items.sort((a, b) => a.ts - b.ts)
  const lines = [`📋 <b>תור לקריאה (${items.length}):</b>`, '']
  items.forEach(item => {
    const preview = (item.text || '').slice(0, 70) + ((item.text || '').length > 70 ? '…' : '')
    lines.push(`• ${escapeHtmlTg(preview)}`)
  })
  const markup = {
    inline_keyboard: items.map(item => {
      const preview = (item.text || '').slice(0, 18)
      return [
        { text: `⚡ ${preview}…`, callback_data: `process_later:${item.key}` },
        { text: '🗑', callback_data: `delete_later:${item.key}` },
      ]
    }),
  }
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, lines.join('\n'), 'HTML', markup)
}

export async function handleMetaInstruction(message, env) {
  await sendTelegram(
    env.TELEGRAM_BOT_TOKEN,
    message.chat.id,
    'ℹ️ זו הנחיית תיוק — אבל אין לי תוכן לצרף אליה.\nשלח את התוכן וההנחיה באותה הודעה (למשל: תמונה עם הכיתוב "שמור במתכונים"), או השב עם ההנחיה על ההודעה המקורית.',
  )
}

export async function handleJournalEntry(message, env) {
  const chatId = message.chat.id
  const text = message.text || message.caption || ''
  // Guard: a filing instruction misclassified as journal must not become a journal page
  if (META_INSTRUCTION_RE.test(text.trim())) return handleMetaInstruction(message, env)
  const timestamp = new Date(message.date * 1000)
  // Format in Asia/Jerusalem so date/time match when the user actually sent it
  const tz = 'Asia/Jerusalem'
  const fmt = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts })
  const ymd = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp)  // YYYY-MM-DD
  const hm = fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)   // HH:MM
  // Compute IL offset (+02:00 or +03:00 depending on DST)
  const offsetParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(timestamp).find(p => p.type === 'timeZoneName')?.value || 'GMT+02:00'
  const offset = offsetParts.replace('GMT', '') || '+02:00'
  const datetimeIso = `${ymd}T${hm}:00${offset}`
  const dateStr = ymd
  const slug = `${dateStr}-${timestamp.getTime()}`

  try {
    await sendTyping(env.TELEGRAM_BOT_TOKEN, chatId)

    const prompt = `You are analyzing a personal journal entry. Extract structured data.

Entry: "${text}"

Respond with JSON only:
{
  "title": "short Hebrew title (max 6 words)",
  "insight": "the core insight or feeling in one sentence (Hebrew)",
  "mood": "positive | negative | neutral | mixed",
  "tags": ["array", "of", "relevant", "tags", "in", "Hebrew or English", "max 4"]
}`

    let aiResult = { title: text.slice(0, 40), insight: text, mood: 'neutral', tags: [] }
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' } }) }
      )
      const data = await geminiRes.json()
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (raw) aiResult = { ...aiResult, ...JSON.parse(raw) }
    } catch {}

    const allTags = [...new Set(['journal', 'telegram', aiResult.mood, ...aiResult.tags].filter(Boolean))]
    const frontmatter = [
      '---',
      `title: "${aiResult.title.replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `time: "${hm}"`,
      `datetime: ${datetimeIso}`,
      `timezone: ${tz}`,
      `type: journal`,
      `mood: ${aiResult.mood}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      '---',
    ].join('\n')

    const body = [`> ${aiResult.insight}`, '', text].join('\n')
    const fullContent = frontmatter + '\n\n' + body + '\n'

    await commitFile(`content/journal/${slug}.md`, fullContent, `journal: ${aiResult.title}`, env, false, true)

    const moodEmoji = { positive: '🌟', negative: '🌧', neutral: '📝', mixed: '🌤' }[aiResult.mood] || '📝'
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const deleteMarkup = { inline_keyboard: [[
      { text: '🔗 פתח', url: `${siteUrl}/journal/${slug}` },
      { text: '🗑 מחק', callback_data: `del:journal/${slug}` },
    ]]}
    await sendTelegram(
      env.TELEGRAM_BOT_TOKEN, chatId,
      `${moodEmoji} <b>נשמר ביומן</b>\n\n📝 <b>${escapeHtmlTg(aiResult.title)}</b>\n💭 ${escapeHtmlTg(aiResult.insight)}\n\n🕒 ${dateStr} ${hm}`,
      'HTML', deleteMarkup
    )
  } catch (err) {
    console.error('handleJournalEntry error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ שגיאה בשמירת הרשומה')
  }
}

export async function handleRecipeEntry(message, env) {
  const chatId = message.chat.id
  const text = (message.text || message.caption || '').replace(/שמור במתכונים|שמור מתכון|תוסיף למתכונים|למתכונים|זה מתכון|save recipe|save to recipes/gi, '').trim()
  const timestamp = new Date(message.date * 1000)
  const dateStr = timestamp.toISOString().split('T')[0]
  const slug = `${dateStr}-${timestamp.getTime()}`

  try {
    await sendTyping(env.TELEGRAM_BOT_TOKEN, chatId)

    let imageMarkdown = ''
    let rawText = message._visionText || text
    let imageBuffer = null
    let mimeType = 'image/jpeg'

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id
      const fileUrl = await getTelegramFileUrl(fileId, env.TELEGRAM_BOT_TOKEN)
      if (fileUrl) {
        const ext = fileUrl.includes('.png') ? 'png' : 'jpg'
        mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
        const imagePath = `content/attachments/${slug}.${ext}`
        imageMarkdown = `![[attachments/${slug}.${ext}]]`
        if (!message._visionText) {
          // Vision not yet done (came from explicit intent, not processMessage)
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '👁 מנתח תמונה...')
          const resp = await fetch(fileUrl)
          imageBuffer = await resp.arrayBuffer()
          await commitFile(imagePath, imageBuffer, `Add recipe image ${slug}`, env, true, true)
          const vision = await extractImageContent(imageBuffer, mimeType, env)
          if (vision.text) rawText = vision.text + (text ? `\n\n${text}` : '')
        } else {
          // Image already committed by processMessage — just set the markdown
          rawText = message._visionText + (text ? `\n\n${text}` : '')
        }
      }
    }

    const prompt = `You are extracting a recipe from a user's message (may be Hebrew or English).

Content: """${rawText.slice(0, 2000)}"""

Return ONLY valid JSON:
{
  "title": "short recipe name (Hebrew if original is Hebrew, max 8 words)",
  "description": "one-sentence description (Hebrew if original is Hebrew)",
  "ingredients": ["array of ingredients, one per item"],
  "instructions": ["array of steps, one per item"],
  "tags": ["up to 4 relevant tags e.g. salad, vegan, quick, breakfast"]
}`

    let aiResult = { title: 'מתכון', description: '', ingredients: [], instructions: [], tags: [] }
    try {
      if (env.GEMINI_API_KEY) {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json' } }) }
        )
        const data = await geminiRes.json()
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text
        if (raw) aiResult = { ...aiResult, ...JSON.parse(raw) }
      } else {
        const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
        })
        const raw = r.response?.match(/\{[\s\S]*\}/)?.[0]
        if (raw) aiResult = { ...aiResult, ...JSON.parse(raw) }
      }
    } catch {}

    const allTags = [...new Set(['recipe', 'telegram', ...aiResult.tags].filter(Boolean))]
    const safeTitle = (aiResult.title || 'מתכון').replace(/"/g, "'")
    const frontmatter = [
      '---',
      `title: "${safeTitle}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: telegram`,
      '---',
    ].join('\n')

    const bodyParts = []
    if (imageMarkdown) bodyParts.push(imageMarkdown, '')
    if (aiResult.description) bodyParts.push(`> ${aiResult.description}`, '')
    if (aiResult.ingredients.length) {
      bodyParts.push('## מרכיבים', '')
      aiResult.ingredients.forEach(i => bodyParts.push(`- ${i}`))
      bodyParts.push('')
    }
    if (aiResult.instructions.length) {
      bodyParts.push('## הוראות הכנה', '')
      aiResult.instructions.forEach((s, idx) => bodyParts.push(`${idx + 1}. ${s}`))
      bodyParts.push('')
    }
    if (rawText && !aiResult.ingredients.length && !aiResult.instructions.length) {
      bodyParts.push(rawText)
    }

    const fullContent = frontmatter + '\n\n' + bodyParts.join('\n') + '\n'
    await commitFile(`content/recipes/${slug}.md`, fullContent, `recipe: ${safeTitle}`, env, false, true)

    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const deleteMarkup = { inline_keyboard: [[
      { text: '🔗 פתח', url: `${siteUrl}/recipes/${slug}` },
      { text: '🗑 מחק', callback_data: `del:recipes/${slug}` },
    ]]}
    await sendTelegram(
      env.TELEGRAM_BOT_TOKEN, chatId,
      `🍽️ <b>שמרתי במתכונים</b>\n\n📝 <b>${safeTitle}</b>${aiResult.description ? `\n💭 ${aiResult.description}` : ''}`,
      'HTML', deleteMarkup
    )
  } catch (err) {
    console.error('handleRecipeEntry error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ שגיאה בשמירת המתכון')
  }
}

// Parse relative/absolute time from Hebrew/English text. Returns Date or null.
export function parseReminderTime(text, now) {
  const t = text

  // עוד X דקות / in X minutes
  const minsMatch = t.match(/עוד\s+(\d+)\s*(דקות?|minutes?)/i) || t.match(/in\s+(\d+)\s*min/i)
  if (minsMatch) return new Date(now.getTime() + parseInt(minsMatch[1]) * 60000)

  // עוד דקה / in a minute
  if (/עוד\s+דקה|in\s+a?\s*minute/i.test(t)) return new Date(now.getTime() + 60000)

  // עוד X שעות / in X hours
  const hrsMatch = t.match(/עוד\s+(\d+)\s*(שעות?|hours?)/i) || t.match(/in\s+(\d+)\s*hour/i)
  if (hrsMatch) return new Date(now.getTime() + parseInt(hrsMatch[1]) * 3600000)

  // עוד שעה / in an hour
  if (/עוד\s+שעה|in\s+an?\s*hour/i.test(t)) return new Date(now.getTime() + 3600000)

  // בשעה HH:MM or at HH:MM — today or tomorrow if past
  const timeMatch = t.match(/(?:בשעה|ב-|at)\s*(\d{1,2}):(\d{2})/)
    || t.match(/\b(\d{1,2}):(\d{2})\b/)
  if (timeMatch) {
    // now is UTC; Israel is UTC+3
    const israelNow = new Date(now.getTime() + 3 * 3600000)
    const candidate = new Date(Date.UTC(
      israelNow.getUTCFullYear(), israelNow.getUTCMonth(), israelNow.getUTCDate(),
      parseInt(timeMatch[1]) - 3, parseInt(timeMatch[2]) // convert Israel hour back to UTC
    ))
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1) // push to tomorrow
    return candidate
  }

  return null
}

// Extract reminder message text (strip the time/trigger words)
export function extractReminderMessage(text) {
  return text
    .replace(/תזכיר\s+לי|remind\s+me/gi, '')
    .replace(/עוד\s+\d+\s*(דקות?|שעות?|minutes?|hours?)/gi, '')
    .replace(/עוד\s+(דקה|שעה)|in\s+a?\s*(minute|hour)/gi, '')
    .replace(/(?:בשעה|ב-|at)\s*\d{1,2}:\d{2}/gi, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/^[\s,\-–—:]+|[\s,\-–—:]+$/g, '')
    .trim() || text.trim()
}

export async function handleSetReminder(message, env) {
  const chatId = message.chat.id
  const text = message.text || message.caption || ''
  try {
    const now = new Date()
    let scheduledAt = parseReminderTime(text, now)
    let reminderMsg = extractReminderMessage(text)

    // Fallback to LLM for expressions we couldn't parse (e.g. "מחר בבוקר", "ביום ראשון")
    if (!scheduledAt) {
      const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          {
            role: 'system',
            content: `You are a reminder time parser. Current UTC time: ${now.toISOString()} (Israel = UTC+3).
Return ONLY a JSON object, no markdown:
{"scheduledAt":"<ISO8601 with +03:00>","message":"<reminder text in original language>","valid":true}
or {"valid":false} if no clear future time found.`,
          },
          { role: 'user', content: text },
        ],
        max_tokens: 150,
      })
      const raw = (typeof result.response === 'string' ? result.response : JSON.stringify(result)).trim()
      const jsonMatch = raw.match(/\{[\s\S]*?\}/)
      let parsed
      try { parsed = JSON.parse(jsonMatch?.[0] ?? raw) } catch { parsed = { valid: false } }
      if (!parsed.valid) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❓ לא הצלחתי לזהות זמן. נסה: "תזכיר לי X בשעה HH:MM" או "תזכיר לי X עוד 30 דקות"')
        return
      }
      scheduledAt = new Date(parsed.scheduledAt)
      if (parsed.message) reminderMsg = parsed.message
    }

    if (isNaN(scheduledAt.getTime()) || scheduledAt <= now) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ הזמן שציינת כבר עבר. ציין זמן עתידי.')
      return
    }

    const id = crypto.randomUUID().slice(0, 8)
    const key = `reminder:${scheduledAt.getTime()}:${id}`
    await env.BRAIN_KV.put(key, JSON.stringify({ message: reminderMsg, chatId: String(chatId), scheduledAt: scheduledAt.toISOString() }))
    // Update the next-reminder cache if this reminder fires sooner than the current earliest
    const currentNext = await env.BRAIN_KV.get('meta:reminder_next')
    if (!currentNext || scheduledAt.getTime() < parseInt(currentNext, 10)) {
      await env.BRAIN_KV.put('meta:reminder_next', String(scheduledAt.getTime()))
    }
    const timeStr = scheduledAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })
    const dateStr = scheduledAt.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' })
    const cancelMarkup = { inline_keyboard: [[{ text: '❌ בטל תזכורת', callback_data: `cancel_reminder:${key}` }]] }
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `✅ תזכורת נקבעה ל-${dateStr} בשעה ${timeStr}:\n"${reminderMsg}"`, undefined, cancelMarkup)
  } catch (err) {
    console.error('handleSetReminder error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `❌ שגיאה: ${err?.message || String(err)}`)
  }
}

export async function handleListReminders(message, env) {
  const chatId = message.chat.id
  try {
    const list = await env.BRAIN_KV.list({ prefix: 'reminder:' })
    const now = Date.now()
    const mine = []
    for (const key of list.keys) {
      const val = await env.BRAIN_KV.get(key.name, 'json')
      if (!val || val.chatId !== String(chatId)) continue
      mine.push({ key: key.name, ...val })
    }
    if (mine.length === 0) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '📭 אין תזכורות פעילות.')
      return
    }
    const lines = mine
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
      .map(r => {
        const d = new Date(r.scheduledAt)
        const time = d.toLocaleString('he-IL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })
        return `• ${time} — ${r.message}`
      })
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `📋 תזכורות פעילות:\n${lines.join('\n')}`)
  } catch (err) {
    console.error('handleListReminders error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❌ שגיאה בטעינת תזכורות.')
  }
}

// Helper: scan all reminders and update meta:reminder_next with the earliest upcoming timestamp.
// Uses one KV list op — call only when the cache may be stale (after add/delete/process).
export async function updateNextReminder(env) {
  const list = await env.BRAIN_KV.list({ prefix: 'reminder:' })
  const now = Date.now()
  const futureTimes = list.keys
    .map(k => parseInt(k.name.split(':')[1], 10))
    .filter(ts => !isNaN(ts) && ts > now)
  if (futureTimes.length) {
    await env.BRAIN_KV.put('meta:reminder_next', String(Math.min(...futureTimes)))
  } else {
    await env.BRAIN_KV.delete('meta:reminder_next')
  }
}

export async function processReminders(env) {
  try {
    // Fast path: a single get() (free, not a list op) tells us if anything is due.
    // Only fall through to the expensive list() when a reminder is actually due.
    const nextStr = await env.BRAIN_KV.get('meta:reminder_next')
    if (nextStr && parseInt(nextStr, 10) > Date.now()) return

    const list = await env.BRAIN_KV.list({ prefix: 'reminder:' })
    const now = Date.now()
    for (const key of list.keys) {
      const [, tsStr] = key.name.split(':')
      if (parseInt(tsStr, 10) > now) continue
      const val = await env.BRAIN_KV.get(key.name, 'json')
      if (!val) { await env.BRAIN_KV.delete(key.name); continue }
      try {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, val.chatId, `⏰ תזכורת: ${val.message}`)
      } catch (err) {
        console.error('processReminders send error:', err)
      }
      await env.BRAIN_KV.delete(key.name)
    }
    // Refresh the cache so the next cron tick can use the fast path again
    await updateNextReminder(env)
  } catch (err) {
    console.error('processReminders error:', err)
  }
}

export async function handleWebSearch(message, env) {
  const chatId = message.chat.id
  const query = (message.text || '')
    .replace(/^(חפש|search for|find|google)\s*/i, '')
    .trim()
  if (!query) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🔍 מה לחפש? לדוגמה: "חפש מה חדש ב-Claude API"')
    return
  }
  if (!env.GEMINI_API_KEY) {
    await handleTelegramQuery(message, env)
    return
  }
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🔍 מחפש...')
  try {
    const { answer, sources } = await geminiWebSearch(query, env)
    const lines = [`🌐 <b>${escapeHtmlTg(query)}</b>`, '', escapeHtmlTg(answer)]
    if (sources.length) {
      lines.push('', '📰 <b>מקורות:</b>')
      sources.slice(0, 3).forEach(s => {
        const title = s.title || s.uri || ''
        lines.push(`  • <a href="${escapeHtmlTg(s.uri || '')}">${escapeHtmlTg(title)}</a>`)
      })
    }
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, lines.join('\n'), 'HTML')
  } catch (err) {
    console.error('handleWebSearch error:', err)
    // 429 = Gemini quota exhausted — fall back to CF AI (no live web, but still useful)
    if (err.message?.includes('429') && env.AI) {
      try {
        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Answer based on your training data.' },
            { role: 'user', content: query },
          ],
          max_tokens: 800,
        })
        const answer = result?.response?.trim() || ''
        if (answer) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
            `🤖 <b>${escapeHtmlTg(query)}</b>\n\n${escapeHtmlTg(answer)}\n\n⚠️ <i>Gemini quota exhausted — תשובה מ-training data, לא חיפוש חי</i>`,
            'HTML')
          return
        }
      } catch {}
    }
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
      `❌ ××××¤××© × ××©×: ${err.message}\n\n💡 × ×¡× ×× ×¡× ××××© ×× × ×¡× ×©××.`)
  }
}

// ── Auto-connections: notify related notes after save ─────────────────
export async function notifyRelatedNotes(slug, title, chatId, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return
  try {
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    // Supabase hybrid search + rerank; dedup chunks → notes, drop self, keep top 3.
    const notes = await retrieveRelevantNotes(title, [], siteUrl, env)
    const related = []
    const seen = new Set([slug])
    for (const n of notes) {
      if (seen.has(n.slug)) continue
      seen.add(n.slug)
      related.push(n)
      if (related.length >= 3) break
    }
    if (!related.length) return
    const lines = ['', '🔗 <b>נוטות קשורות:</b>']
    related.forEach(n => {
      lines.push(`  • <a href="${siteUrl}/${n.slug}">${escapeHtmlTg(n.title || n.slug)}</a>`)
    })
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, String(chatId), lines.join('\n'), 'HTML')
  } catch (err) {
    console.error('notifyRelatedNotes error:', err)
  }
}