// Second Brain — POST /api/search
// Semantic search: hybrid retrieve → rerank → return ranked note excerpts

import { retrieve } from '../_lib/retrieve.js'

const COOKIE_NAME = 'brain_auth'

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

export async function onRequestPost(context) {
  const { request, env } = context

  if (env.SITE_PASSPHRASE && !(await isAuthed(request, env.SITE_PASSPHRASE))) {
    return new Response('Unauthorized', { status: 401 })
  }

  let query, limit
  try {
    ;({ query, limit = 5 } = await request.json())
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  if (!query?.trim()) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { sources } = await retrieve(query, env, request.url, {
    topK: Math.min(limit, 10),
    candidates: Math.min(limit * 6, 50),
    skipGraph: true,   // search results don't need graph expansion
  })

  const results = sources.map(s => ({
    id:      s.note_id,
    title:   s.title,
    type:    s.type,
    url:     s.url,
  }))

  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
