// Second Brain — POST /api/chat
// RAG chat: hybrid retrieve (pgvector+pgroonga) → rerank → 1-hop graph → Gemini (streaming)

import { retrieve } from '../_lib/retrieve.js'

const COOKIE_NAME  = 'brain_auth'
const GEMINI_MODEL = 'gemini-2.5-pro'

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function isAuthed(request, secret) {
  const cookieHeader = request.headers.get('Cookie') || ''
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) return false
  const [payload, sig] = match[1].split('.')
  if (!payload || !sig) return false
  const expected = await hmac(secret, payload)
  if (sig !== expected) return false
  const exp = parseInt(payload, 36)
  return Number.isFinite(exp) && exp > Date.now()
}

const SYSTEM_PROMPTS = {
  ask:     'Answer the question based strictly on the provided notes. Be concise and cite note titles.',
  think:   'Reason carefully using the provided notes. Think step by step before answering.',
  draft:   'Draft a structured document or response using the provided notes as source material.',
  connect: 'Identify non-obvious connections and patterns across the provided notes.',
}

export async function onRequestPost(context) {
  const { request, env } = context

  if (env.SITE_PASSPHRASE && !(await isAuthed(request, env.SITE_PASSPHRASE))) {
    return new Response('Unauthorized', { status: 401 })
  }

  let query, mode
  try {
    ;({ query, mode = 'ask' } = await request.json())
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  if (!query?.trim()) return new Response('Missing query', { status: 400 })

  // Retrieve: hybrid search → rerank → graph expand → assemble context
  const { context: chunkContext, sources } = await retrieve(query, env, request.url, {
    cookie: request.headers.get('Cookie') || '',
  })

  if (!chunkContext) {
    // No relevant content found — still answer but tell the LLM
    const emptyNote = 'No relevant notes found in the knowledge base for this query.'
    return streamGemini(emptyNote, query, mode, env)
  }

  return streamGemini(chunkContext, query, mode, env, sources)
}

async function streamGemini(chunkContext, query, mode, env, sources = []) {
  const modeInstruction = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.ask
  const systemText =
    `You are the user's personal knowledge assistant. ${modeInstruction}\n` +
    `If the answer is not in the context, say so — do not hallucinate.`

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent` +
    `?alt=sse&key=${env.GEMINI_API_KEY}`

  const geminiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{
        role: 'user',
        parts: [{ text: `Context:\n\n${chunkContext}\n\nQuestion: ${query}` }],
      }],
      generationConfig: { maxOutputTokens: 2048 },
    }),
  })

  return new Response(geminiRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // Pass sources as a header so the client can render citations
      'X-Sources': JSON.stringify(sources.slice(0, 5)),
    },
  })
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
