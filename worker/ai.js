import { bytesToBase64 } from "./util.js"

// ── Analyze attachment (chat save) ────────────────────────────────────
export async function analyzeAttachment({ message, answer, attachment }, env) {
  const snippet = (attachment.text || '').slice(0, 1500)
  const prompt = `Analyze this chat save and return JSON.

User question: ${message || '(none)'}
Attachment: ${attachment.name} (${attachment.kind})
${snippet ? `Content preview:\n${snippet}\n` : ''}
AI answer: ${(answer || '').slice(0, 600)}

Return ONLY JSON:
{
  "title": "short descriptive title, max 60 chars",
  "tags": ["2-4 specific lowercase tags — prefer concrete work domains (claude-code, presentations, client-research, design-system, prompt-engineering, agentic-platforms) over generic (ai, productivity, tool)"],
  "summary": "1-2 sentence plain-English summary of what this is about",
  "whySaved": "1 short sentence — why the user likely wants to remember this",
  "whenToApply": "1 sentence starting with 'When...' describing the specific work scenario where the user should pull this back up. Empty string if unknown."
}`
  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt, max_tokens: 400 })
    const m = (r.response || '').match(/\{[\s\S]*\}/)
    if (!m) throw new Error('No JSON')
    const p = JSON.parse(m[0])
    return {
      title: (p.title || '').slice(0, 60) || attachment.name,
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 5) : [],
      summary: p.summary || '',
      whySaved: p.whySaved || '',
      whenToApply: p.whenToApply || '',
    }
  } catch (err) {
    console.error('analyzeAttachment err:', err)
    return { title: attachment.name, tags: [attachment.kind], summary: '', whySaved: '', whenToApply: '' }
  }
}

export async function extractImageContent(imageBuffer, mimeType, env) {
  if (env.GEMINI_API_KEY) {
    try {
      const base64 = bytesToBase64(new Uint8Array(imageBuffer))
      const prompt = `Analyze this image. Return ONLY valid JSON:
{"text": "all visible text transcribed exactly, preserving original language (Hebrew, English, etc.). Empty string if no text.", "description": "1-2 sentence description of what the image shows", "source": "if visible, the platform/site/app name (e.g. Facebook, Twitter, LinkedIn, Instagram). Empty if unknown.", "author": "if visible, the post/content author. Empty if unknown."}`
      const raw = await callGemini(env, {
        prompt,
        imageInlineData: { mimeType: mimeType || 'image/jpeg', base64 },
        maxTokens: 1500,
      })
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}')
      return {
        text: json.text || '',
        description: json.description || '',
        source: json.source || '',
        author: json.author || '',
      }
    } catch (err) {
      console.error('Gemini vision error:', err)
    }
  }
  return { text: '', description: '', source: '', author: '' }
}

export async function generateHtmlWithGemini(request, existingHtml, env) {
  if (!env.GEMINI_API_KEY) return null
  const isEdit = !!existingHtml
  const system = isEdit
    ? 'You are an expert web developer. Edit the provided HTML file exactly as requested. Return ONLY the complete updated HTML — no explanation, no markdown fences, just raw HTML starting with <!DOCTYPE html>.'
    : 'You are an expert web developer. Generate a complete, beautiful, self-contained HTML file. Use inline CSS and vanilla JS only (no external CDN except Google Fonts). Make it polished and modern. Return ONLY raw HTML starting with <!DOCTYPE html> — no explanation, no markdown fences.'
  const userContent = isEdit
    ? `Current HTML:\n\`\`\`html\n${existingHtml.slice(0, 12000)}\n\`\`\`\n\nEdit request: ${request}`
    : request
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
        }),
      }
    )
    if (!res.ok) { console.error('Gemini Flash error:', res.status, await res.text()); return null }
    const data = await res.json()
    let html = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
    return (html.startsWith('<!') || html.toLowerCase().startsWith('<html')) ? html : null
  } catch (err) {
    console.error('generateHtmlWithGemini error:', err)
    return null
  }
}


export async function generateHtmlWithCfAI(request, existingHtml, env) {
  if (!env.AI) return null
  const isEdit = !!existingHtml
  const system = isEdit
    ? 'You are an expert web developer. Edit the provided HTML file exactly as requested. Return ONLY the complete updated HTML — no explanation, no markdown fences, just raw HTML starting with <!DOCTYPE html>.'
    : 'You are an expert web developer. Generate a complete, beautiful, self-contained HTML file. Use inline CSS and vanilla JS only (no external CDN except Google Fonts). Make it polished and modern. Return ONLY raw HTML starting with <!DOCTYPE html> — no explanation, no markdown fences.'
  const userContent = isEdit
    ? `Current HTML:\n\`\`\`html\n${existingHtml.slice(0, 8000)}\n\`\`\`\n\nEdit request: ${request}`
    : request
  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      max_tokens: 4096,
    })
    let html = result?.response || ''
    html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
    return (html.startsWith('<!') || html.toLowerCase().startsWith('<html')) ? html : null
  } catch (err) {
    console.error('generateHtmlWithCfAI error:', err)
    return null
  }
}

// ── Gemini API (free tier, native video) ──────────────────────────────
// Requires GEMINI_API_KEY secret. Gemini 2.5 Flash supports video-in, transcription,
// OCR, and JSON-structured output in a single call. Free tier: 1,500 req/day.
export async function callGemini(env, { prompt, videoInlineData, imageInlineData, documentInlineData, youtubeUrl, maxTokens = 4000, model = 'gemini-2.5-flash' }) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set')
  const parts = []
  if (videoInlineData) parts.push({ inlineData: { mimeType: videoInlineData.mimeType || 'video/mp4', data: videoInlineData.base64 } })
  if (imageInlineData) parts.push({ inlineData: { mimeType: imageInlineData.mimeType || 'image/jpeg', data: imageInlineData.base64 } })
  if (documentInlineData) parts.push({ inlineData: { mimeType: documentInlineData.mimeType || 'application/pdf', data: documentInlineData.base64 } })
  if (youtubeUrl) parts.push({ fileData: { fileUri: youtubeUrl } })
  parts.push({ text: prompt })
  const body = {
    contents: [{ parts }],
    generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`
  const timeoutMs = youtubeUrl ? 120000 : 60000
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

export async function geminiWebSearch(query, env) {
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
  const body = {
    tools: [{ google_search: {} }],
    contents: [{ role: 'user', parts: [{ text: query }] }],
    generationConfig: { maxOutputTokens: 1000 },
  }
  let lastErr
  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 429) {
      lastErr = new Error(`Gemini search 429: quota exceeded on ${model}`)
      continue
    }
    if (!res.ok) throw new Error(`Gemini search ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const candidate = data.candidates?.[0]
    const answer = (candidate?.content?.parts || []).map(p => p.text).filter(Boolean).join('') || 'לא נמצאו תוצאות'
    const chunks = candidate?.groundingMetadata?.groundingChunks || []
    const sources = chunks.map(c => c.web).filter(Boolean)
    return { answer, sources }
  }
  throw lastErr
}