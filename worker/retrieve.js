import { handleConversation, loadHistory } from "./handlers.js"

export async function getRecentNotes(siteUrl, limit = 5) {
  try {
    const res = await fetch(`${siteUrl}/static/contentIndex.json`, { cf: { cacheTtl: 60 } })
    if (!res.ok) return []
    const index = await res.json()
    return Object.entries(index)
      .filter(([slug]) => slug.startsWith('inbox/'))
      .map(([slug, data]) => ({ slug, title: data.title || slug, date: data.date || '' }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
  } catch { return [] }
}

// ── RAG: retrieve relevant notes (Supabase hybrid: pgvector + pgroonga + rerank) ─────
export async function retrieveRelevantNotes(query, _history, _siteUrl, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase env vars — retrieval skipped')
    return []
  }
  try {
    // 1. Bilingual expansion (Hebrew → English keywords appended)
    const expandedQuery = await expandQueryBilingually(query, env)

    // 2. Embed with bge-m3 (1024-dim, multilingual)
    const embedRes = await env.AI.run('@cf/baai/bge-m3', { text: [expandedQuery.slice(0, 2000)] })
    const queryVec = embedRes.data[0]

    // 3. Hybrid search: pgvector (dense) + pgroonga (sparse Hebrew/English) via RRF
    const sbHeaders = {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      apikey: env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
    }
    const hybridRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/hybrid_search`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ query_text: expandedQuery, query_embedding: queryVec, match_count: 50 }),
    })
    let candidates = []
    if (hybridRes.ok) {
      candidates = await hybridRes.json()
    } else {
      // hybrid_search is the normal path now that queries and stored chunks share
      // bge-m3 1024-dim (migration 0004). Fall back to the lexical-only text_search
      // RPC (migration 0003) only if it errors (e.g. transient embedding failure).
      console.warn('hybrid_search unavailable, falling back to text_search:', await hybridRes.text())
      const textRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/text_search`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ query_text: expandedQuery, match_count: 50 }),
      })
      if (!textRes.ok) { console.error('text_search error:', await textRes.text()); return [] }
      candidates = await textRes.json()
    }
    if (!candidates.length) return []

    // 4. Rerank with bge-reranker-base → top-5 for Telegram (concise context)
    let top = candidates
    try {
      const r = await env.AI.run('@cf/baai/bge-reranker-base', {
        query: expandedQuery,
        documents: candidates.map(c => c.content.slice(0, 512)),
      })
      const scores = r.scores || r.data || []
      top = candidates
        .map((c, i) => ({ ...c, rerank_score: scores[i] ?? 0 }))
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .slice(0, 5)
    } catch {
      top = candidates.slice(0, 5)
    }

    // Return in the shape handleConversation expects: {title, content, slug}
    return top.map(c => ({ title: c.title, content: c.content, slug: c.note_id }))
  } catch (err) { console.error('Retrieval error:', err); return [] }
}

// Translates Hebrew query terms to English for cross-language keyword search.
// Runs in parallel with loadHistory — adds zero perceived latency.
export async function expandQueryBilingually(query, env) {
  if (!/[֐-׿]/.test(query)) return query // already English or mixed — skip
  try {
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: 'Translate the Hebrew search query to English keywords. Output ONLY space-separated English words (names, nouns, key concepts) — no punctuation, no explanation, no full sentences. Max 10 words.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 30,
    })
    const en = (r.response || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
    return en ? `${query} ${en}` : query
  } catch {
    return query
  }
}

export async function upsertVector(slug, text, metadata, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return
  try {
    const result = await env.AI.run('@cf/baai/bge-m3', { text: [text.slice(0, 2000)] })
    const embedding = result.data[0]
    const row = {
      id:          slug.replace(/\//g, '__') + '__0',
      note_id:     slug,
      title:       metadata.title || slug,
      type:        slug.split('/')[0] || 'inbox',
      chunk_index: 0,
      chunk_total: 1,
      content:     text.slice(0, 4000),
      tags:        Array.isArray(metadata.tags) ? metadata.tags : [],
      embedding,
    }
    await fetch(`${env.SUPABASE_URL}/rest/v1/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        apikey: env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([row]),
    })
  } catch (err) { console.error('upsertVector error:', err) }
}

// Delete all Supabase chunks for a note (used when a note is deleted). The CI
// embed pipeline also prunes deleted notes, but this keeps search consistent
// immediately. Best-effort.
export async function deleteChunksByNote(noteId, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/chunks?note_id=eq.${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        apikey: env.SUPABASE_SERVICE_KEY,
      },
    })
  } catch (err) { console.error('deleteChunksByNote error:', err) }
}