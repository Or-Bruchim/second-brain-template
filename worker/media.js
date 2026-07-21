import { callGemini } from "./ai.js"
import { commitFile, triggerDeploy } from "./github.js"
import { appendActivityLog, handleCalendarEvent, handleImageGeneration, handleJournalEntry, handleMetaInstruction, handleRecipeEntry, handleSetReminder, handleTelegramQuery, handleWebSearch, notifyRelatedNotes, processMessage } from "./handlers.js"
import { routeIntent } from "./intent.js"
import { upsertVector } from "./retrieve.js"
import { getTelegramFileUrl, pollUntilLive, sendTelegram } from "./telegram.js"
import { base64ToBytes, bytesToBase64, decodeGithubContent, escapeHtmlTg, jsonResponse } from "./util.js"

// ── Save uploaded video (web chat) ────────────────────────────────────
export async function handleSaveVideo({ request, env, message, answer, attachment, videoAnalysis, slug, dateStr, safeName, assetPath }) {
  try {
    const base64 = attachment.dataUrl.split(',')[1] || ''
    const bytes = base64ToBytes(base64)

    // Run video upload commit + Gemini analysis in parallel — both only need the bytes
    const videoRef = `attachments/${slug}-${safeName}`
    const videoCommitPromise = commitFile(assetPath, bytes.buffer, `Attach video ${safeName}`, env, true, true)

    let analysisPromise
    if (videoAnalysis) {
      analysisPromise = Promise.resolve(videoAnalysis)
    } else {
      if (!env.GEMINI_API_KEY) {
        await videoCommitPromise.catch(() => {})
        return jsonResponse({ error: 'GEMINI_API_KEY not configured' }, 500)
      }
      analysisPromise = analyzeVideoContent({
        platform: 'upload',
        videoBytes: bytes.buffer,
        videoMime: attachment.mime || 'video/mp4',
        userNote: message,
      }, env)
    }
    const [, analysis] = await Promise.all([videoCommitPromise, analysisPromise])
    if (!analysis) return jsonResponse({ error: 'Video analysis failed' }, 500)

    // Transcript attachment if long
    let transcriptRef = ''
    if (analysis.transcript && analysis.transcript.split(/\s+/).length >= 500) {
      const txtPath = `content/attachments/${slug}-transcript.txt`
      await commitFile(txtPath, analysis.transcript, `Add transcript ${slug}`, env, false, true)
      transcriptRef = `attachments/${slug}-transcript.txt`
    }

    const bodyMd = buildVideoMarkdownBody({
      analysis,
      originalUrl: '',
      thumbRef: '',
      transcriptRef,
      userNote: message || undefined,
    })
    // Embed the uploaded video at the top so it's playable on the note page
    const videoEmbed = `<video controls src="/${videoRef}" style="max-width:100%;border-radius:12px"></video>\n\n`

    const allTags = [...new Set(['inbox', 'chat', 'video', ...(analysis.tags || [])])]
    const frontmatter = [
      '---',
      `title: "${(analysis.title || safeName).replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: chat`,
      `kind: video`,
      `type: video`,
      analysis.whenToApply ? `when_to_apply: "${analysis.whenToApply.replace(/"/g, "'")}"` : '',
      analysis.duration ? `duration: "${analysis.duration}"` : '',
      analysis.partial ? `partial: true` : '',
      '---',
    ].filter(Boolean).join('\n')

    const noteSlug = `inbox/${slug}`
    const fullContent = frontmatter + '\n\n' + videoEmbed + bodyMd + '\n'
    await commitFile(`content/${noteSlug}.md`, fullContent, `Chat save: ${analysis.title || safeName}`, env, false, true)
    await Promise.all([
      appendActivityLog({ from: 'Chat', kind: analysis.partial ? 'video (partial)' : 'video', title: analysis.title || safeName, slug: noteSlug, env }),
      triggerDeploy(env),
    ])

    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    return jsonResponse({
      noteUrl: `${siteUrl}/${noteSlug}`,
      title: analysis.title || safeName,
      summary: analysis.summary || '',
      whySaved: analysis.whySaved || '',
      tags: allTags.filter(t => t !== 'inbox'),
      kind: 'video',
      filename: safeName,
    })
  } catch (err) {
    console.error('handleSaveVideo error:', err)
    return jsonResponse({ error: 'Video save failed', detail: String(err) }, 500)
  }
}

// ── Video utilities ───────────────────────────────────────────────────
export const MAX_VIDEO_INLINE_BYTES = 20 * 1024 * 1024 // 20 MB — Gemini inline_data safe limit
export const MAX_VIDEO_DURATION_SEC = 10 * 60          // 10 min cap

export function youtubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([\w-]{11})/)
  return m?.[1] || null
}

export function detectVideoPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube'
  if (url.includes('tiktok.com')) return 'tiktok'
  if (url.includes('instagram.com') && /\/reel|\/p\//.test(url)) return 'instagram'
  if ((url.includes('twitter.com') || url.includes('x.com')) && /\/status\//.test(url)) return 'twitter'
  return null
}

export function pickThumbnailUrl(videoUrl, platform, pageHtml) {
  if (platform === 'youtube') {
    const id = youtubeId(videoUrl)
    if (id) return `https://img.youtube.com/vi/${id}/maxresdefault.jpg`
  }
  if (pageHtml) {
    const og = pageHtml.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
    if (og) return og.replace(/&amp;/g, '&')
  }
  return null
}

// Returns { bytes, mime, pageHtml, tooLarge } — any of those may be null.
export async function downloadSocialVideo(url, platform) {
  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    if (!pageRes.ok) return null
    const pageHtml = await pageRes.text()

    const patterns = [
      /<meta[^>]+property="og:video:url"[^>]+content="([^"]+)"/i,
      /<meta[^>]+property="og:video:secure_url"[^>]+content="([^"]+)"/i,
      /<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i,
      /<meta[^>]+name="twitter:player:stream"[^>]+content="([^"]+)"/i,
    ]
    let mp4Url = null
    for (const p of patterns) {
      const m = pageHtml.match(p)
      if (m?.[1]) { mp4Url = m[1].replace(/&amp;/g, '&'); break }
    }
    if (!mp4Url && platform === 'instagram') {
      const m = pageHtml.match(/"video_url":"([^"]+)"/)
      if (m?.[1]) mp4Url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    }
    if (!mp4Url && platform === 'tiktok') {
      const m = pageHtml.match(/"playAddr":"([^"]+)"/)
      if (m?.[1]) mp4Url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    }
    if (!mp4Url) return { bytes: null, mime: null, pageHtml }

    const videoRes = await fetch(mp4Url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
      signal: AbortSignal.timeout(25000),
    })
    if (!videoRes.ok) return { bytes: null, mime: null, pageHtml }

    const contentLength = parseInt(videoRes.headers.get('content-length') || '0')
    if (contentLength && contentLength > MAX_VIDEO_INLINE_BYTES) {
      return { bytes: null, mime: null, pageHtml, tooLarge: true }
    }
    const bytes = await videoRes.arrayBuffer()
    if (bytes.byteLength > MAX_VIDEO_INLINE_BYTES) {
      return { bytes: null, mime: null, pageHtml, tooLarge: true }
    }
    return { bytes, mime: videoRes.headers.get('content-type') || 'video/mp4', pageHtml }
  } catch (err) {
    console.error('downloadSocialVideo error:', err)
    return null
  }
}

// ── YouTube transcript + metadata via public APIs ─────────────────────
export async function fetchYouTubeData(videoId) {
  const result = { title: null, author: null, durationSec: null, transcript: null }
  try {
    // 1. oEmbed — free, no key needed, reliable for title + author
    const oe = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(6000) }
    )
    if (oe.ok) {
      const d = await oe.json()
      result.title  = d.title || null
      result.author = d.author_name || null
    }
  } catch {}

  try {
    // 2. Watch page — extract caption track URL + duration
    const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!page.ok) return result
    const html = await page.text()

    // Duration
    const durMatch = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/)
    if (durMatch) result.durationSec = Math.round(parseInt(durMatch[1]) / 1000)

    // Caption track baseUrl — prefer English auto-generated
    const trackMatches = [...html.matchAll(/"baseUrl"\s*:\s*"(https:\\\/\\\/www\.youtube\.com\\\/api\\\/timedtext[^"]+)"/g)]
    if (!trackMatches.length) return result

    // Decode first English track (or first available)
    let captionUrl = null
    for (const m of trackMatches) {
      const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
      if (url.includes('lang=en') || !captionUrl) captionUrl = url
    }
    if (!captionUrl) return result

    // 3. Fetch timed-text as JSON3
    const cap = await fetch(captionUrl + '&fmt=json3', { signal: AbortSignal.timeout(8000) })
    if (!cap.ok) return result
    const capData = await cap.json()
    const lines = (capData.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim())
      .filter(Boolean)
    result.transcript = lines.join(' ').slice(0, 20000) || null
  } catch {}

  return result
}

// Core video analyzer — Gemini 2.5 Flash extracts transcript, visuals, mentions, tags.
// Returns structured result or null on failure.
export async function analyzeVideoContent({ url, platform, videoBytes, videoMime, userNote, hashtags, existingMeta }, env) {
  if (!env.GEMINI_API_KEY) return null

  const basePromptFields = `
- title: max 60 chars, clear and specific
- summary: 3-4 sentences in plain English — what is this about, who said it, what's the main argument or insight?
- whySaved: 1-2 sentences — why would the user want to remember this? what problem does it solve or what question does it answer?
- whenToApply: 1-2 sentences starting with "When..." — specific work scenario where this is directly useful. Empty string if unclear.
- tags: 4-8 lowercase specific work-context tags (prefer: claude-code, presentations, client-research, design-system, prompt-engineering, agentic-platforms, context-management, product-strategy, ai-tools, workflow)
- keyPoints: 5-8 actionable takeaways, each a full sentence under 150 chars — be specific and concrete, not generic
- context: 2-3 sentences on the broader topic area, industry context, or why this topic matters right now
- mentions: { "products": [], "people": [], "companies": [], "links": [] }
- transcript: verbatim transcript or full caption ("" if not available)
- visualNotes: 2-3 sentences on visual style, what's shown on screen, UI/UX patterns, or presentation technique ("" for text-only)
- durationSec: integer seconds (0 if unknown)

Return ONLY: {"title":"...","summary":"...","whySaved":"...","whenToApply":"...","tags":["..."],"keyPoints":["..."],"context":"...","mentions":{"products":[],"people":[],"companies":[],"links":[]},"transcript":"...","visualNotes":"...","durationSec":0}`

  const prompt = `You are analyzing a video for the user's personal knowledge base. Return ONLY valid JSON — no prose, no markdown fences.

${userNote ? `User's note when saving: "${userNote}"\n` : ''}${hashtags?.length ? `User's hashtags: ${hashtags.join(', ')}\n` : ''}${existingMeta?.author ? `Channel/Author: ${existingMeta.author}\n` : ''}${existingMeta?.title ? `Known title: ${existingMeta.title}\n` : ''}
Analyze the video (audio + visuals + on-screen text) and extract:
${basePromptFields}`

  try {
    let raw
    if (platform === 'youtube') {
      // Primary path: fetch transcript + metadata, then analyze as text (fast + reliable)
      const videoId = youtubeId(url)
      const ytData = videoId ? await fetchYouTubeData(videoId) : null

      if (ytData?.transcript) {
        const author = ytData.author || existingMeta?.author || ''
        const title  = ytData.title  || existingMeta?.title  || ''
        const dur    = ytData.durationSec ? `${Math.floor(ytData.durationSec/60)}:${String(ytData.durationSec%60).padStart(2,'0')}` : ''
        const transcriptPrompt = `You are analyzing a YouTube video for the user's personal knowledge base. Return ONLY valid JSON — no prose, no markdown fences.

Video URL: ${url}${title  ? `\nTitle: ${title}`   : ''}${author ? `\nChannel: ${author}` : ''}${dur    ? `\nDuration: ${dur}`   : ''}${userNote ? `\nUser's note: "${userNote}"` : ''}${hashtags?.length ? `\nHashtags: ${hashtags.join(', ')}` : ''}

Full transcript:
${ytData.transcript}

Based on the transcript above, extract:
${basePromptFields}`

        raw = await callGemini(env, { prompt: transcriptPrompt, maxTokens: 4000 })
        // Inject known metadata into parsed result below
        if (!existingMeta) existingMeta = {}
        if (ytData.title  && !existingMeta.title)  existingMeta.title  = ytData.title
        if (ytData.author && !existingMeta.author) existingMeta.author = ytData.author
        if (ytData.durationSec && !existingMeta.durationSec) existingMeta.durationSec = ytData.durationSec
      } else {
        // Fallback: Gemini native YouTube URL (handles videos without captions)
        raw = await callGemini(env, { prompt, youtubeUrl: url, maxTokens: 4000 })
      }
    } else if (videoBytes) {
      const base64 = bytesToBase64(videoBytes)
      raw = await callGemini(env, { prompt, videoInlineData: { mimeType: videoMime || 'video/mp4', base64 }, maxTokens: 4000 })
    } else if (existingMeta && (existingMeta.description || existingMeta.title)) {
      // Text-only path — analyze caption/metadata when video bytes unavailable (e.g. Instagram)
      const caption = existingMeta.description || existingMeta.title || ''
      const textPrompt = `You are analyzing a social media post for the user's personal knowledge base. Return ONLY valid JSON — no prose, no markdown fences.

Platform: ${platform || 'social media'}${existingMeta.author ? `\nAuthor/Account: @${existingMeta.author}` : ''}${existingMeta.title && existingMeta.description ? `\nShort title: ${existingMeta.title}` : ''}${userNote ? `\nUser's note: "${userNote}"` : ''}${hashtags?.length ? `\nHashtags: ${hashtags.join(', ')}` : ''}

Full post caption:
${caption}

Based on the caption above, extract:
${basePromptFields}`
      raw = await callGemini(env, { prompt: textPrompt, maxTokens: 3000 })
    } else {
      return null
    }
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('No JSON in Gemini response')
    const parsed = JSON.parse(m[0])

    const durationSec = parseInt(parsed.durationSec) || parseInt(existingMeta?.durationSec) || 0
    const duration = durationSec > 0 ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}` : ''
    const tooLong = durationSec > MAX_VIDEO_DURATION_SEC

    return {
      title: (parsed.title || '').slice(0, 80),
      summary: parsed.summary || '',
      whySaved: parsed.whySaved || '',
      whenToApply: parsed.whenToApply || '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map(t => String(t).toLowerCase()) : [],
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 8) : [],
      context: parsed.context || '',
      mentions: {
        products: Array.isArray(parsed.mentions?.products) ? parsed.mentions.products.slice(0, 10) : [],
        people: Array.isArray(parsed.mentions?.people) ? parsed.mentions.people.slice(0, 10) : [],
        companies: Array.isArray(parsed.mentions?.companies) ? parsed.mentions.companies.slice(0, 10) : [],
        links: Array.isArray(parsed.mentions?.links) ? parsed.mentions.links.slice(0, 10) : [],
      },
      transcript: tooLong ? '' : (parsed.transcript || ''),
      visualNotes: parsed.visualNotes || '',
      durationSec,
      duration,
      partial: tooLong,
      partialReason: tooLong ? `Video exceeds ${MAX_VIDEO_DURATION_SEC / 60}-min cap — summary only` : undefined,
    }
  } catch (err) {
    console.error('analyzeVideoContent error:', err)
    return null
  }
}

// Builds markdown body for a video note.
export function buildVideoMarkdownBody({ analysis, originalUrl, thumbRef, transcriptRef, userNote, author }) {
  const body = []
  if (thumbRef) body.push(`![[${thumbRef}]]`, '')
  if (analysis.summary) body.push(`> ${analysis.summary}`, '')
  if (analysis.partial && analysis.partialReason) body.push(`⚠️ *${analysis.partialReason}*`, '')

  if (originalUrl) body.push(`**Source:** [${analysis.title || originalUrl}](${originalUrl})`)
  if (author) body.push(`**By:** ${author}`)
  if (analysis.duration) body.push(`**Duration:** ${analysis.duration}`)
  body.push('')

  if (analysis.whySaved) body.push(`**Why saved:** ${analysis.whySaved}`, '')
  if (analysis.whenToApply) body.push(`**When to apply:** ${analysis.whenToApply}`, '')
  if (userNote) body.push(`**Note:** ${userNote}`, '')

  if (analysis.keyPoints?.length) {
    body.push('## Key points')
    analysis.keyPoints.forEach(p => body.push(`- ${p}`))
    body.push('')
  }

  if (analysis.context) body.push(`**Context:** ${analysis.context}`, '')

  const { products = [], people = [], companies = [], links = [] } = analysis.mentions || {}
  if (products.length || people.length || companies.length || links.length) {
    body.push('## Mentioned')
    if (products.length) body.push(`- **Products/tools:** ${products.join(', ')}`)
    if (people.length) body.push(`- **People:** ${people.join(', ')}`)
    if (companies.length) body.push(`- **Companies:** ${companies.join(', ')}`)
    if (links.length) {
      body.push('- **Links:**')
      links.forEach(l => body.push(`  - ${l}`))
    }
    body.push('')
  }

  if (analysis.visualNotes) body.push(`**Visual notes:** ${analysis.visualNotes}`, '')

  if (analysis.transcript) {
    const wordCount = analysis.transcript.trim().split(/\s+/).length
    if (transcriptRef) {
      body.push(`📄 [[${transcriptRef}|Full transcript (${wordCount} words)]]`, '')
    } else {
      body.push('<details>', '<summary>Transcript</summary>', '', analysis.transcript, '', '</details>', '')
    }
  }
  return body.join('\n')
}

// ── Document content extraction ───────────────────────────────────────
// PDFs go through Gemini (native PDF support). Text-like files are decoded directly.
// Other binary files are saved as attachments with no content extraction.
export const TEXT_LIKE_EXTS = ['txt','md','markdown','json','csv','tsv','log','js','jsx','ts','tsx','py','rb','go','rs','java','c','h','cpp','hpp','cs','swift','kt','php','sh','bash','zsh','sql','html','htm','css','scss','xml','yaml','yml','toml','ini','env','conf']
export const TEXT_LIKE_MIME_PREFIXES = ['text/']
export const TEXT_LIKE_MIMES = new Set(['application/json','application/xml','application/javascript','application/x-yaml','application/x-sh','application/x-toml'])

export function isPdf(mimeType, fileName) {
  if (mimeType === 'application/pdf') return true
  return (fileName || '').toLowerCase().endsWith('.pdf')
}

export function isTextLike(mimeType, fileName) {
  if (mimeType && TEXT_LIKE_MIME_PREFIXES.some(p => mimeType.startsWith(p))) return true
  if (mimeType && TEXT_LIKE_MIMES.has(mimeType)) return true
  const ext = (fileName || '').toLowerCase().split('.').pop() || ''
  return TEXT_LIKE_EXTS.includes(ext)
}

export async function extractDocumentContent({ buffer, mimeType, fileName }, env) {
  const result = { text: '', summary: '', title: '', keyPoints: [], tags: [], language: '', kind: 'document', method: 'none' }

  // PDF via Gemini (native PDF support, returns structured JSON)
  if (isPdf(mimeType, fileName)) {
    result.kind = 'pdf'
    if (!env.GEMINI_API_KEY) { result.summary = 'GEMINI_API_KEY not set — saved file only.'; return result }
    if (buffer.byteLength > 20 * 1024 * 1024) { result.summary = 'PDF >20MB — too large for inline analysis. Saved file only.'; return result }
    try {
      const base64 = bytesToBase64(new Uint8Array(buffer))
      const prompt = `Extract structured content from this PDF for a personal knowledge base. Return ONLY valid JSON:
{
  "title": "short descriptive title (max 80 chars), inferred from the document",
  "summary": "1-3 sentence overview of what this document is about",
  "fullText": "the main textual content, cleaned up, up to 8000 chars. Preserve structure with line breaks. If the document is in Hebrew, keep it in Hebrew.",
  "keyPoints": ["3-6 actionable takeaways or core points from the document"],
  "tags": ["3-6 lowercase topical tags"],
  "language": "he | en | other"
}
Be faithful to the actual content. Do not invent.`
      const r = await callGemini(env, {
        prompt,
        documentInlineData: { mimeType: 'application/pdf', base64 },
        maxTokens: 8000,
      })
      const raw = typeof r === 'string' ? r : (r?.response || '')
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
      result.text = parsed.fullText || ''
      result.summary = parsed.summary || ''
      result.title = parsed.title || ''
      result.keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : []
      result.tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : []
      result.language = parsed.language || ''
      result.method = 'gemini-pdf'
    } catch (err) {
      console.error('PDF extract error:', err)
      result.summary = 'PDF content extraction failed — saved file only.'
    }
    return result
  }

  // Text-like files: decode UTF-8 directly
  if (isTextLike(mimeType, fileName)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      result.text = text.slice(0, 50000)
      result.method = 'plain-text'
      const ext = (fileName || '').toLowerCase().split('.').pop() || ''
      result.kind = ext === 'md' || ext === 'markdown' ? 'markdown' : (mimeType?.startsWith('text/') && !ext.match(/^(js|ts|py|rb|go)/) ? 'text' : 'code')
    } catch (err) { console.error('text decode error:', err) }
    return result
  }

  return result
}

// ── Document message flow (PDF, txt, code, etc.) ──────────────────────
export async function processDocumentMessage({ message, env, slug, dateStr, userNote, hashtags, ctx }) {
  try {
    const doc = message.document
    const rawName = doc.file_name || `file-${doc.file_unique_id}`
    const mimeType = doc.mime_type || ''
    const safeName = rawName.replace(/[^a-zA-Z0-9._֐-׿-]/g, '_').slice(0, 80)
    const ext = (safeName.match(/\.[^.]+$/) || [''])[0].toLowerCase().slice(1) || 'bin'

    const fileUrl = await getTelegramFileUrl(doc.file_id, env.TELEGRAM_BOT_TOKEN)
    if (!fileUrl) {
      try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, '❌ לא הצלחתי להוריד את הקובץ מטלגרם') } catch {}
      return
    }

    const resp = await fetch(fileUrl)
    const buffer = await resp.arrayBuffer()

    if (buffer.byteLength > 25 * 1024 * 1024) {
      try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `⚠️ הקובץ גדול מדי (${Math.round(buffer.byteLength/1024/1024)}MB). הגבולה היא 25MB.`) } catch {}
      return
    }

    const isPdfFile = isPdf(mimeType, safeName)
    try {
      const progressMsg = isPdfFile ? '📄 מנתח PDF...' : (isTextLike(mimeType, safeName) ? '📝 קורא קובץ...' : '📎 שומר קובץ...')
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, progressMsg)
    } catch {}

    const attachmentPath = `content/attachments/${slug}-${safeName}`
    const attachmentRef = `attachments/${slug}-${safeName}`

    // Run commit + content extraction in parallel — both only need the buffer
    const [, extracted] = await Promise.all([
      commitFile(attachmentPath, buffer, `Add file ${safeName}`, env, true, true),
      extractDocumentContent({ buffer, mimeType, fileName: safeName }, env),
    ])

    // Build aiResult: prefer Gemini's structured output for PDFs, fall back to LLM analysis
    let aiResult
    if (extracted.method === 'gemini-pdf' && extracted.title) {
      aiResult = {
        title: extracted.title.slice(0, 80),
        tags: extracted.tags || [],
        summary: extracted.summary || '',
        whySaved: '',
        keyPoints: extracted.keyPoints || [],
      }
    } else {
      // Fold extracted text into the user note for the LLM analyzer
      const augmentedNote = [
        userNote,
        extracted.text ? `\n[File: ${safeName} (${extracted.kind})]\n${extracted.text.slice(0, 4000)}` : `\n[File attached: ${safeName} (${ext})]`,
      ].filter(Boolean).join('').trim()
      aiResult = await analyzeWithAI({
        userNote: augmentedNote,
        hashtags,
        richUrls: [],
        hasImage: false,
        imageVision: { text: '', description: '', source: '', author: '' },
      }, env)
      if (!aiResult.title || aiResult.title === 'Note') aiResult.title = safeName.slice(0, 80)
    }

    const allTags = [...new Set(['inbox', 'telegram', extracted.kind || 'document', ext, ...hashtags, ...(aiResult.tags || [])])]

    const bodyParts = []
    // Embed: Quartz renders ![[file.pdf]] as a PDF viewer; other files become download links
    if (isPdfFile) bodyParts.push(`![[${attachmentRef}]]`, '')
    else bodyParts.push(`📎 [[${attachmentRef}|${safeName}]]`, '')
    if (aiResult.summary) bodyParts.push(`> ${aiResult.summary}`, '')
    if (userNote) bodyParts.push(`**Note:** ${userNote}`, '')
    if (aiResult.whySaved) bodyParts.push(`**Why saved:** ${aiResult.whySaved}`, '')
    if (aiResult.keyPoints?.length) {
      bodyParts.push('', '**Key points:**')
      aiResult.keyPoints.forEach(p => bodyParts.push(`- ${p}`))
      bodyParts.push('')
    }
    if (extracted.text) {
      const previewLimit = 8000
      bodyParts.push('---', '', '## Content', '')
      const preview = extracted.text.slice(0, previewLimit)
      // Wrap code/text in a fence so Quartz renders it cleanly
      if (extracted.kind === 'code' || extracted.kind === 'text') {
        bodyParts.push('```' + (extracted.kind === 'code' ? ext : ''), preview, '```')
      } else {
        bodyParts.push(preview)
      }
      if (extracted.text.length > previewLimit) bodyParts.push('', `*... (${extracted.text.length - previewLimit} more characters truncated)*`)
      bodyParts.push('')
    }

    const frontmatter = [
      '---',
      `title: "${aiResult.title.replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: telegram`,
      `kind: ${extracted.kind || 'document'}`,
      `filename: "${safeName.replace(/"/g, "'")}"`,
      mimeType ? `mime: "${mimeType}"` : '',
      extracted.language ? `language: ${extracted.language}` : '',
      '---',
    ].filter(Boolean).join('\n')

    const noteSlug = `inbox/${slug}`
    const fullContent = frontmatter + '\n\n' + bodyParts.join('\n') + '\n'
    await commitFile(`content/${noteSlug}.md`, fullContent, `Add file: ${aiResult.title}`, env, false, true)

    const tagLine = allTags.filter(t => t !== 'inbox').join(', ') || (extracted.kind || 'document')
    const icon = isPdfFile ? '📄' : (extracted.kind === 'code' ? '💻' : (extracted.kind === 'text' || extracted.kind === 'markdown' ? '📝' : '📎'))
    const lines = [`✅ <b>Saved to Brain</b>`, '', `${icon} <b>${escapeHtmlTg(aiResult.title)}</b>`, `<i>${escapeHtmlTg(safeName)}</i>`]
    if (aiResult.summary) lines.push('', `💭 ${escapeHtmlTg(aiResult.summary)}`)
    if (aiResult.keyPoints?.length) {
      lines.push('', '🔑 <i>Key points:</i>')
      aiResult.keyPoints.slice(0, 3).forEach(p => lines.push(`  • ${escapeHtmlTg(p)}`))
    }
    lines.push('', `🏷 ${escapeHtmlTg(tagLine)}`)
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const noteUrl = `${siteUrl}/${noteSlug}`
    lines.push('', `🔗 <a href="${noteUrl}">Open in Brain</a> <i>(deploying…)</i>`)
    const deleteMarkup = { inline_keyboard: [[{ text: '🗑 מחק', callback_data: `del:${slug}` }]] }

    const embedText = [
      aiResult.title,
      aiResult.summary,
      allTags.join(' '),
      userNote,
      extracted.text ? extracted.text.slice(0, 2000) : '',
      aiResult.keyPoints?.join(' '),
    ].filter(Boolean).join(' ')

    const [msgId] = await Promise.all([
      sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML', deleteMarkup),
      upsertVector(noteSlug, embedText, { title: aiResult.title }, env),
      appendActivityLog({ from: 'Telegram', kind: extracted.kind || 'document', title: aiResult.title, slug: noteSlug, env }),
      triggerDeploy(env),
    ])
    if (ctx && msgId) {
      const finalText = lines.join('\n').replace(' <i>(deploying…)</i>', '')
      ctx.waitUntil(pollUntilLive(env, message.chat.id, msgId, noteUrl, finalText))
    }
    notifyRelatedNotes(noteSlug, aiResult.title, message.chat.id, env).catch(() => {})
  } catch (err) {
    console.error('processDocumentMessage error:', err)
    try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `❌ Save failed: ${err.message}`) } catch {}
  }
}

// ── Video-specific Telegram save flow ─────────────────────────────────
// Returns true if the video was handled (analyzed + saved + replied to).
// Returns false if the caller should fall through to the metadata-only path.
export async function processVideoMessage({ message, env, slug, dateStr, userNote, hashtags, ctx, url, platform, existingMeta }) {
  try {
    try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `🎬 Analyzing ${platform} video…`) } catch {}
    let videoBytes = null, videoMime = null, pageHtml = null
    if (platform !== 'youtube') {
      const dl = await downloadSocialVideo(url, platform)
      if (!dl) return false
      pageHtml = dl.pageHtml
      videoBytes = dl.bytes
      videoMime = dl.mime
      if (!videoBytes) {
        // Video download failed — try text-based analysis using caption from oembed/metadata
        if (existingMeta?.description && existingMeta.description.length > 20) {
          try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `📝 Couldn't download video — analyzing caption instead…`) } catch {}
          const textAnalysis = await analyzeVideoContent({ platform, userNote, hashtags, existingMeta }, env)
          if (textAnalysis) {
            let thumbRef = ''
            if (existingMeta.image) {
              try {
                const tr = await fetch(existingMeta.image, { signal: AbortSignal.timeout(10000) })
                if (tr.ok) {
                  const buf = await tr.arrayBuffer()
                  if (buf.byteLength > 100 && buf.byteLength < 5 * 1024 * 1024) {
                    const thumbPath = `content/attachments/${slug}-thumb.jpg`
                    await commitFile(thumbPath, buf, `Add thumb ${slug}`, env, true, true)
                    thumbRef = `attachments/${slug}-thumb.jpg`
                  }
                }
              } catch {}
            }
            const body = buildVideoMarkdownBody({ analysis: textAnalysis, originalUrl: url, thumbRef, userNote: userNote || undefined, author: existingMeta.author })
            const allTags = [...new Set(['inbox', 'telegram', 'video', platform, ...hashtags, ...(textAnalysis.tags || [])])]
            const fm = [
              '---',
              `title: "${(textAnalysis.title || 'Video').replace(/"/g, "'")}"`,
              `date: ${dateStr}`,
              `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
              `source: telegram`,
              `type: video`,
              `kind: video`,
              `url: "${url}"`,
              existingMeta.author ? `author: "${String(existingMeta.author).replace(/"/g, "'")}"` : '',
              '---',
            ].filter(Boolean).join('\n')
            const noteSlug = `inbox/${slug}`
            await commitFile(`content/${noteSlug}.md`, fm + '\n\n' + body + '\n', `Add video: ${textAnalysis.title || 'Video'}`, env, false, true)
            const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
            const noteUrl = `${siteUrl}/${noteSlug}`
            const tagLine = allTags.filter(t => t !== 'inbox').join(', ')
            const lines = ['✅ <b>Saved to Brain</b> <i>(caption analysis)</i>', '', `🎬 <b>${escapeHtmlTg(textAnalysis.title || 'Video')}</b>`]
            if (textAnalysis.summary) lines.push('', `💭 ${escapeHtmlTg(textAnalysis.summary)}`)
            if (textAnalysis.whySaved) lines.push('', `🎯 <i>Why saved:</i> ${escapeHtmlTg(textAnalysis.whySaved)}`)
            if (textAnalysis.keyPoints?.length) {
              lines.push('', '🔑 <i>Key points:</i>')
              textAnalysis.keyPoints.slice(0, 3).forEach(p => lines.push(`  • ${escapeHtmlTg(p)}`))
            }
            lines.push('', `🏷 ${escapeHtmlTg(tagLine)}`)
            lines.push('', `🔗 <a href="${noteUrl}">Open in Brain</a> <i>(deploying…)</i>`)
            const deleteMarkup = { inline_keyboard: [[{ text: '🗑 מחק', callback_data: `del:${slug}` }]] }
            const [msgId] = await Promise.all([
              sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML', deleteMarkup),
              upsertVector(noteSlug, [textAnalysis.title, textAnalysis.summary, textAnalysis.keyPoints?.join(' '), userNote].filter(Boolean).join(' '), { title: textAnalysis.title || 'Video' }, env),
              appendActivityLog({ from: 'Telegram', kind: 'video (caption)', title: textAnalysis.title || 'Video', slug: noteSlug, env }),
              triggerDeploy(env),
            ])
            if (ctx && msgId) {
              const finalText = lines.join('\n').replace(' <i>(deploying…)</i>', '')
              ctx.waitUntil(pollUntilLive(env, message.chat.id, msgId, noteUrl, finalText))
            }
            notifyRelatedNotes(noteSlug, textAnalysis.title || 'Video', message.chat.id, env).catch(() => {})
            return true
          }
        }
        try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `⚠️ Couldn't download video from ${platform}. Saving metadata only.`) } catch {}
        return false
      }
    }

    const analysis = await analyzeVideoContent({
      url: platform === 'youtube' ? url : undefined,
      platform,
      videoBytes,
      videoMime,
      userNote,
      hashtags,
      existingMeta,
    }, env)
    if (!analysis) return false

    // Thumbnail — download and commit as attachment
    let thumbRef = ''
    const thumbUrl = pickThumbnailUrl(url, platform, pageHtml)
    if (thumbUrl) {
      try {
        const tr = await fetch(thumbUrl, { signal: AbortSignal.timeout(10000) })
        if (tr.ok) {
          const buf = await tr.arrayBuffer()
          if (buf.byteLength > 100 && buf.byteLength < 5 * 1024 * 1024) {
            const ext = (thumbUrl.match(/\.(png|webp|jpe?g)(\?|$)/i)?.[1] || 'jpg').toLowerCase()
            const thumbPath = `content/attachments/${slug}-thumb.${ext === 'jpeg' ? 'jpg' : ext}`
            await commitFile(thumbPath, buf, `Add thumb ${slug}`, env, true, true)
            thumbRef = `attachments/${slug}-thumb.${ext === 'jpeg' ? 'jpg' : ext}`
          }
        }
      } catch (err) { console.error('thumb fetch error:', err) }
    }

    // Transcript — external attachment if long
    let transcriptRef = ''
    if (analysis.transcript && analysis.transcript.split(/\s+/).length >= 500) {
      const txtPath = `content/attachments/${slug}-transcript.txt`
      await commitFile(txtPath, analysis.transcript, `Add transcript ${slug}`, env, false, true)
      transcriptRef = `attachments/${slug}-transcript.txt`
    }

    const body = buildVideoMarkdownBody({
      analysis,
      originalUrl: url,
      thumbRef,
      transcriptRef,
      userNote: userNote || undefined,
      author: existingMeta?.author || undefined,
    })

    const allTags = [...new Set(['inbox', 'telegram', 'video', platform, ...hashtags, ...(analysis.tags || [])])]
    const frontmatterLines = [
      '---',
      `title: "${(analysis.title || 'Video').replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(', ')}]`,
      `source: telegram`,
      `type: video`,
      `kind: video`,
      `url: "${url}"`,
      analysis.duration ? `duration: "${analysis.duration}"` : '',
      existingMeta?.author ? `author: "${String(existingMeta.author).replace(/"/g, "'")}"` : '',
      analysis.partial ? `partial: true` : '',
      '---',
    ].filter(Boolean).join('\n')

    const noteSlug = `inbox/${slug}`
    const fullContent = frontmatterLines + '\n\n' + body + '\n'
    await commitFile(`content/${noteSlug}.md`, fullContent, `Add video: ${analysis.title || 'Video'}`, env, false, true)

    // Telegram reply
    const tagLine = allTags.filter(t => t !== 'inbox').join(', ') || 'video'
    const lines = ['✅ <b>Saved video to Brain</b>', '', `🎬 <b>${escapeHtmlTg(analysis.title || 'Video')}</b>`]
    if (analysis.duration) lines.push(`⏱ ${escapeHtmlTg(analysis.duration)}`)
    if (analysis.summary) lines.push('', `💭 ${escapeHtmlTg(analysis.summary)}`)
    if (analysis.whySaved) lines.push('', `🎯 <i>Why saved:</i> ${escapeHtmlTg(analysis.whySaved)}`)
    if (analysis.keyPoints?.length) {
      lines.push('', '🔑 <i>Key points:</i>')
      analysis.keyPoints.slice(0, 3).forEach(p => lines.push(`  • ${escapeHtmlTg(p)}`))
    }
    if (analysis.partial) lines.push('', `⚠️ ${escapeHtmlTg(analysis.partialReason || 'partial save')}`)
    lines.push('', `🏷 ${escapeHtmlTg(tagLine)}`)
    const siteUrl = env.SITE_URL || 'https://your-project.pages.dev'
    const noteUrl = `${siteUrl}/inbox/${slug}`
    lines.push('', `🔗 <a href="${noteUrl}">Open in Brain</a> <i>(deploying…)</i>`)
    if (env.BOT_USERNAME) {
      const ts = slug.split('-').pop()
      lines.push(`🤖 <a href="https://t.me/${env.BOT_USERNAME}?start=note_${ts}">Share via Bot</a>`)
    }
    const deleteMarkup = { inline_keyboard: [[{ text: '🗑 מחק', callback_data: `del:${slug}` }]] }

    const videoEmbedText = [
      analysis.title, analysis.title,
      analysis.summary,
      allTags.join(' '),
      analysis.keyPoints?.join(' '),
      userNote,
      analysis.transcript ? analysis.transcript.slice(0, 1500) : '',
    ].filter(Boolean).join(' ').slice(0, 2000)

    // Run reply + background tasks in parallel — user sees ✅ as soon as send returns
    const [msgId] = await Promise.all([
      sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, lines.join('\n'), 'HTML', deleteMarkup),
      upsertVector(noteSlug, videoEmbedText, { title: analysis.title || 'Video' }, env),
      appendActivityLog({ from: 'Telegram', kind: analysis.partial ? 'video (partial)' : 'video', title: analysis.title || 'Video', slug: noteSlug, env }),
      triggerDeploy(env),
    ])
    if (ctx && msgId) {
      const finalText = lines.join('\n').replace(' <i>(deploying…)</i>', '')
      ctx.waitUntil(pollUntilLive(env, message.chat.id, msgId, noteUrl, finalText))
    }
    notifyRelatedNotes(noteSlug, analysis.title || 'Video', message.chat.id, env).catch(() => {})
    return true
  } catch (err) {
    console.error('processVideoMessage error:', err)
    try { await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, `⚠️ Video analysis failed: ${err.message}. Trying metadata-only.`) } catch {}
    return false
  }
}

// ── Analyze Telegram message ──────────────────────────────────────────
export async function analyzeWithAI({ userNote, hashtags, richUrls, hasImage, imageVision }, env) {
  const visionBlock = imageVision && (imageVision.text || imageVision.description) ? [
    'Image content (extracted via vision AI):',
    imageVision.source ? `Source platform: ${imageVision.source}` : '',
    imageVision.author ? `Author: ${imageVision.author}` : '',
    imageVision.description ? `Description: ${imageVision.description}` : '',
    imageVision.text ? `Visible text:\n${imageVision.text.slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n') : ''

  const context = [
    userNote ? `User note: "${userNote}"` : '',
    hashtags.length ? `User hashtags: ${hashtags.join(', ')}` : '',
    visionBlock || (hasImage ? 'User sent an image (vision unavailable).' : ''),
    ...richUrls.map(r => [
      `URL: ${r.url}`,
      r.title ? `Title: ${r.title}` : '',
      r.author ? `Author/Channel: ${r.author}` : '',
      r.type ? `Type: ${r.type}` : '',
      r.description ? `Description: ${r.description.slice(0, 400)}` : '',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n\n')
  const hasRealContent = userNote || richUrls.some(r => r.description && r.description.length > 30) || (imageVision && (imageVision.text || imageVision.description))
  const prompt = `You are a personal knowledge base assistant. Return JSON.

ITEM:
${context}

Return ONLY valid JSON:
{"title":"...","tags":["..."],"summary":"...","whySaved":"...","whenToApply":"...","keyPoints":[]}

CRITICAL RULES:
- DO NOT invent or hallucinate content. Only describe what is actually in the ITEM above.
- If you only have a URL with a generic site name (e.g. "Facebook", "Twitter", "LinkedIn") and NO description, the actual post content is unavailable — set summary to "Couldn't extract post content. Saved as link reference." and leave keyPoints as an EMPTY array [].
- title: a short, faithful descriptor of the actual content. If unknown, use the site name + brief context (e.g. "Facebook post (content not extracted)"). Max 60 chars.
- tags: lowercase, SPECIFIC to the user's work context. Prefer concrete domains over generic tags like "ai", "productivity", "tool". 2-5 tags max.
- summary: 1-2 sentences ONLY based on real description text. If no description exists, use the fallback above.
- whySaved: 1 sentence guess based on the user's likely interest, or "Saved for later reference" if unknown.
- whenToApply: 1 sentence describing the SPECIFIC scenario where the user should pull this back up — start with "When..." (e.g. "When building a presentation that needs animated storyboards"). If content is missing, return "".
- keyPoints: 2-3 ACTIONABLE takeaways from REAL content. If content is missing, return [].
${hasRealContent ? '' : '\nNOTE: The content fetch returned only a generic site title with no description. The real post content is NOT available. Do NOT invent details.'}`
  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt, max_tokens: 400 })
    const raw = response.response || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON')
    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.keyPoints?.length && richUrls.length) richUrls[0].keyPoints = parsed.keyPoints
    return {
      title: parsed.title || guessTitle({ userNote, richUrls }),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : [],
      summary: parsed.summary || '',
      whySaved: parsed.whySaved || '',
      whenToApply: parsed.whenToApply || '',
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 3) : [],
    }
  } catch {
    return { title: guessTitle({ userNote, richUrls }), tags: richUrls.map(r => detectSource(r.url)), summary: '', whySaved: '', whenToApply: '', keyPoints: [] }
  }
}

export function guessTitle({ userNote, richUrls }) {
  if (userNote) return userNote.split('\n')[0].slice(0, 60)
  if (richUrls.length && richUrls[0].title) return richUrls[0].title.slice(0, 60)
  return 'Note'
}

// ── URL metadata fetchers ─────────────────────────────────────────────
export async function fetchRichMeta(url, env) {
  const base = { url, title: '', description: '', author: '', type: 'link', duration: '', keyPoints: [], topics: [] }
  try {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return await fetchYouTubeMeta(url, base)
    if (url.includes('instagram.com')) return await fetchInstagramMeta(url, base, env)
    if (url.includes('twitter.com') || url.includes('x.com')) return await fetchTwitterMeta(url, base)
    if (url.includes('tiktok.com')) return await fetchTikTokMeta(url, base)
    if (url.includes('github.com')) return await fetchGitHubMeta(url, base, env)
    if (url.includes('linkedin.com')) return await fetchLinkedInMeta(url, base)
    return await fetchGenericMeta(url, base)
  } catch { return base }
}

export async function fetchLinkedInMeta(url, base) {
  // LinkedIn blocks most crawlers. Try user agents that LinkedIn serves content to.
  const agents = [
    'LinkedInBot/1.0 (compatible; compatible; +http://www.linkedin.com)',
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ]
  for (const ua of agents) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const html = await res.text()
      const get = (patterns) => {
        for (const p of patterns) {
          const m = html.match(p)
          if (m?.[1]) return m[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\\n/g, ' ')
        }
        return ''
      }
      const title = get([
        /<meta[^>]+property="og:title"[^>]+content="([^"]{1,200})"/i,
        /<meta[^>]+content="([^"]{1,200})"[^>]+property="og:title"/i,
        /<title[^>]*>([^<]{1,200})<\/title>/i,
      ])
      const description = get([
        /<meta[^>]+property="og:description"[^>]+content="([^"]{1,800})"/i,
        /<meta[^>]+content="([^"]{1,800})"[^>]+property="og:description"/i,
        /<meta[^>]+name="description"[^>]+content="([^"]{1,800})"/i,
      ])
      const author = get([
        /<meta[^>]+property="article:author"[^>]+content="([^"]{1,100})"/i,
        /"author":\{"@type":"Person","name":"([^"]{1,100})"/i,
      ])
      if (title || description) {
        base.title = title
        base.description = description.slice(0, 800)
        base.author = author
        return base
      }
    } catch {}
  }
  return base
}

export async function fetchYouTubeMeta(url, base) {
  base.type = 'video'
  // Run oembed + page fetch in parallel — independent endpoints
  const [oembedRes, pageRes] = await Promise.all([
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`).catch(() => null),
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null),
  ])
  try {
    if (oembedRes && oembedRes.ok) {
      const data = await oembedRes.json()
      base.title = data.title || ''
      base.author = data.author_name || ''
    }
  } catch {}
  try {
    if (pageRes && pageRes.ok) {
      const html = await pageRes.text()
      const desc = html.match(/"description":\{"simpleText":"([^"]+)"/)?.[1] || html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] || ''
      base.description = desc.replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 600)
      const duration = html.match(/"lengthSeconds":"(\d+)"/)?.[1]
      if (duration) { const s = parseInt(duration); base.duration = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
    }
  } catch {}
  return base
}

export async function fetchInstagramMeta(url, base, env) {
  base.type = url.includes('/reel/') ? 'video' : 'post'

  // Instagram oembed — public endpoint, returns full caption + author + thumbnail
  try {
    const oe = await fetch(`https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&omitscript=true`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (oe.ok) {
      const data = await oe.json()
      if (data.author_name) base.author = data.author_name
      if (data.thumbnail_url) base.image = data.thumbnail_url
      if (data.title && data.title !== 'Instagram') {
        base.description = data.title
        base.title = data.title.slice(0, 100)
      } else {
        base.title = `Instagram ${base.type} by @${data.author_name || 'unknown'}`
      }
      return base
    }
  } catch {}

  // Fallback: OG tags — try with session cookie first, then anonymous
  const sessionId = env?.INSTAGRAM_SESSION_ID
  const cookieHeader = sessionId ? `sessionid=${sessionId}; ig_did=1; ig_nrcb=1` : null
  for (const useAuth of (cookieHeader ? [true, false] : [false])) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(useAuth && cookieHeader ? { Cookie: cookieHeader } : {}),
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      if (!res.ok) continue
      const html = await res.text()
      const title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] || ''
      const desc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || ''
      const author = html.match(/"owner":\{"username":"([^"]+)"/)?.[1]
        || html.match(/"username":"([^"]+)"/)?.[1]
        || url.match(/instagram\.com\/([^/?]+)\//)?.[1] || ''
      if (title && title !== 'Instagram' && title !== 'Log in to Instagram') {
        base.title = title
        base.description = desc
        if (author) base.author = author
        return base
      }
    } catch {}
  }

  // Gemini url_context fallback — Google's crawler can access public Instagram posts
  if (env && env.GEMINI_API_KEY) {
    try {
      const body = {
        contents: [{ parts: [{ text: `Fetch this Instagram URL and extract the post content. Return JSON with: {"caption": "full post caption/text", "author": "username without @", "description": "1-2 sentence summary of what this post is about"}. URL: ${url}` }] }],
        tools: [{ url_context: {} }],
        generationConfig: { maxOutputTokens: 800 },
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }
      )
      if (res.ok) {
        const data = await res.json()
        const raw = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || ''
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        const parsed = JSON.parse(cleaned)
        if (parsed.caption || parsed.description) {
          base.description = parsed.caption || parsed.description
          base.title = parsed.caption ? parsed.caption.slice(0, 100) : `Instagram ${base.type}`
          if (parsed.author) base.author = parsed.author
          return base
        }
      }
    } catch {}
  }

  return base
}

export async function fetchTwitterMeta(url, base) {
  base.type = 'post'
  try {
    const oembed = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`)
    if (oembed.ok) { const data = await oembed.json(); base.description = data.html?.replace(/<[^>]+>/g, '').trim() || ''; base.author = data.author_name || ''; base.title = `Tweet by ${base.author}` }
  } catch {}
  return base
}

export async function fetchTikTokMeta(url, base) {
  base.type = 'video'
  try {
    const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
    if (oembed.ok) { const data = await oembed.json(); base.title = data.title || 'TikTok'; base.author = data.author_name || '' }
  } catch {}
  return base
}

export async function fetchGitHubMeta(url, base, env) {
  base.type = 'repo'
  const match = url.match(/github\.com\/([^/]+)\/([^/?#\s]+)/)
  if (!match) return await fetchGenericMeta(url, base)
  const [, owner, repo] = match
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'OrBrain/1.0',
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  }
  const [repoRes, readmeRes] = await Promise.all([
    fetch(apiBase, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null),
    fetch(`${apiBase}/readme`, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null),
  ])
  if (!repoRes?.ok) return await fetchGenericMeta(url, base)
  const data = await repoRes.json()
  base.title = data.full_name || `${owner}/${repo}`
  base.description = data.description || ''
  base.author = owner
  base.topics = data.topics || []
  base.language = data.language || ''
  base.stars = data.stargazers_count || 0
  base.license = data.license?.spdx_id || ''
  base.homepage = data.homepage || ''
  base.pushedAt = data.pushed_at?.split('T')[0] || ''
  base.keyPoints = [
    data.language && `**Language:** ${data.language}`,
    data.stargazers_count && `**Stars:** ${data.stargazers_count.toLocaleString()}`,
    data.topics?.length && `**Topics:** ${data.topics.join(', ')}`,
    data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' && `**License:** ${data.license.spdx_id}`,
    data.homepage && `**Homepage:** ${data.homepage}`,
    data.pushed_at && `**Last push:** ${data.pushed_at.split('T')[0]}`,
  ].filter(Boolean)
  if (readmeRes?.ok) {
    try {
      const rd = await readmeRes.json()
      const decoded = decodeGithubContent(rd.content)
      const clean = decoded
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/#{1,6} /g, '')
        .replace(/(<([^>]+)>)/g, '')
        .trim()
      base.readme = clean.slice(0, 1500)
    } catch {}
  }
  return base
}

export async function fetchGenericMeta(url, base) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(6000) })
  if (!res.ok) return base
  const html = await res.text()
  const get = (patterns) => { for (const p of patterns) { const m = html.match(p); if (m?.[1]) return m[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') } return '' }
  base.title = get([/<meta[^>]+property="og:title"[^>]+content="([^"]{1,200})"/i, /<meta[^>]+content="([^"]{1,200})"[^>]+property="og:title"/i, /<title[^>]*>([^<]{1,200})<\/title>/i])
  base.description = get([/<meta[^>]+property="og:description"[^>]+content="([^"]{1,400})"/i, /<meta[^>]+name="description"[^>]+content="([^"]{1,400})"/i])
  return base
}

export function extractUrls(text, entities) {
  const urls = new Set()
  for (const e of entities) { if (e.type === 'url') urls.add(text.substring(e.offset, e.offset + e.length)); else if (e.type === 'text_link' && e.url) urls.add(e.url) }
  for (const m of text.matchAll(/https?:\/\/[^\s\])"]+/g)) urls.add(m[0])
  return [...urls]
}

export function detectSource(url) {
  if (url.includes('instagram.com')) return 'instagram'
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter'
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('tiktok.com')) return 'tiktok'
  if (url.includes('github.com')) return 'github'
  if (url.includes('figma.com')) return 'figma'
  return 'link'
}

// ── Voice transcription via Cloudflare Whisper ────────────────────────
export async function handleVoiceMessage(message, env) {
  const chatId = message.chat.id
  const voice = message.voice || message.audio
  if (!voice?.file_id) return
  try {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '🎤 מתמלל...')
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${voice.file_id}`
    )
    if (!fileRes.ok) throw new Error(`getFile failed: ${fileRes.status}`)
    const fileData = await fileRes.json()
    const filePath = fileData.result?.file_path
    if (!filePath) throw new Error('No file path returned')
    const dlRes = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
      { signal: AbortSignal.timeout(30000) }
    )
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`)
    const buffer = await dlRes.arrayBuffer()
    const whisperResult = await env.AI.run('@cf/openai/whisper', {
      audio: [...new Uint8Array(buffer)],
    })
    const transcript = (whisperResult?.text || '').trim()
    if (!transcript) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '❓ לא הצלחתי להבין את ההודעה הקולית. נסה שוב.')
      return
    }
    // Echo the transcript so the user can see what was heard
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `🎤 <i>${escapeHtmlTg(transcript)}</i>`, 'HTML')
    // Route based on intent — same unified classifier as text messages
    const synth = { ...message, text: transcript, voice: undefined, audio: undefined }
    const { intent } = await routeIntent({ text: transcript, hasMedia: false, hasUrl: false, env })
    switch (intent) {
      case 'QUERY':      return await handleTelegramQuery(synth, env)
      case 'JOURNAL':    return await handleJournalEntry(synth, env)
      case 'RECIPE':     return await handleRecipeEntry(synth, env)
      case 'REMINDER':   return await handleSetReminder(synth, env)
      case 'WEB_SEARCH': return await handleWebSearch(synth, env)
      case 'IMAGE_GEN':  return await handleImageGeneration(synth, env)
      case 'CALENDAR':   return await handleCalendarEvent(synth, env)
      case 'META':       return await handleMetaInstruction(synth, env)
      case 'SKIP':       return
      default:           return await processMessage(synth, env, { skipClassifier: true })
    }
  } catch (err) {
    console.error('handleVoiceMessage error:', err)
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `❌ תמלול נכשל: ${err.message}`)
  }
}