/**
 * retrieve.js — shared retrieval module for Second Brain
 *
 * Used by:
 *   functions/api/chat.js    (web RAG chat)
 *   functions/api/search.js  (web semantic search)
 *   worker/telegram-bot.js   (Telegram bot)
 *
 * Pipeline:
 *   1. Query expansion (bilingual Hebrew→English)
 *   2. Embed query with bge-m3 (1024-dim, multilingual)
 *   3. hybrid_search RPC in Supabase (pgvector dense + pgroonga sparse, RRF)
 *   4. Rerank with bge-reranker-base → keep top-k
 *   5. 1-hop graph expansion (fetch real neighbor content, not just names)
 *   6. Assemble full-text context with citations
 */

// ── Query expansion ──────────────────────────────────────────────────────────

/**
 * If the query is Hebrew-only, ask the LLM to add an English translation
 * so bge-m3 can match English content in the knowledge base.
 * The bot already did this; now the web path benefits too.
 */
export async function expandQueryBilingually(query, AI) {
  if (!/[א-ת]/.test(query)) return query // no Hebrew — skip
  try {
    const r = await AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            "You are a query expansion assistant. The user's query is in Hebrew. " +
            "Return the original Hebrew query followed by a concise English translation, " +
            "separated by a newline. Return ONLY that — no explanations.",
        },
        { role: "user", content: query },
      ],
      max_tokens: 80,
    })
    const expanded = (r.response || "").trim()
    return expanded || query
  } catch {
    return query // never block retrieval on expansion failure
  }
}

// ── Embed ────────────────────────────────────────────────────────────────────

export async function embedQuery(text, AI) {
  const r = await AI.run("@cf/baai/bge-m3", { text: [text] })
  return r.data[0] // float[] 1024-dim
}

// ── Supabase hybrid search ───────────────────────────────────────────────────

/**
 * Calls the hybrid_search RPC in Supabase (pgvector + pgroonga RRF).
 * Returns up to candidateCount rows for reranking.
 */
export async function hybridSearch(queryText, queryEmbedding, env, candidateCount = 50) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/hybrid_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      apikey: env.SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_text: queryText,
      query_embedding: queryEmbedding,
      match_count: candidateCount,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`hybrid_search failed (${res.status}): ${err}`)
  }
  return res.json() // array of {id,note_id,title,type,content,tags,chunk_index,rrf_score}
}

/**
 * Lexical-only fallback (pgroonga). Used only when hybrid_search errors
 * (e.g. a transient Workers AI embedding failure). Documents and queries now
 * share bge-m3 1024-dim (migration 0004), so hybrid_search is the normal path.
 */
export async function textSearch(queryText, env, candidateCount = 50) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/text_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      apikey: env.SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_text: queryText,
      match_count: candidateCount,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`text_search failed (${res.status}): ${err}`)
  }
  return res.json()
}

// ── Reranking ────────────────────────────────────────────────────────────────

/**
 * Reranks candidates using bge-reranker-base (cross-encoder).
 * Much slower than embedding but runs on a small set (≤50) so latency is fine.
 * Falls back to rrf_score ordering if reranker fails.
 */
export async function rerank(query, candidates, topK, AI) {
  if (candidates.length === 0) return []
  try {
    const pairs = candidates.map((c) => ({ query, document: c.content.slice(0, 512) }))
    const r = await AI.run("@cf/baai/bge-reranker-base", {
      query,
      documents: pairs.map((p) => p.document),
    })
    const scores = r.scores || r.data || []
    return candidates
      .map((c, i) => ({ ...c, rerank_score: scores[i] ?? 0 }))
      .sort((a, b) => b.rerank_score - a.rerank_score)
      .slice(0, topK)
  } catch {
    // reranker is best-effort — fall back to RRF order
    return candidates.slice(0, topK)
  }
}

// ── Graph expansion ──────────────────────────────────────────────────────────

/**
 * Given a set of hit note IDs, fetch 1-hop wikilink neighbors from graph.json
 * and pull their top chunks from Supabase.
 * Returns up to neighborLimit neighbor chunks with full content.
 */
export async function expandGraph(hitNoteIds, requestUrl, env, neighborLimit = 4, cookie = "") {
  try {
    // Same-origin fetch passes through the auth middleware — forward the
    // caller's cookie so the request is authenticated.
    const graphUrl = new URL("/static/kg/graph.json", requestUrl)
    const graphRes = await fetch(
      graphUrl.toString(),
      cookie ? { headers: { Cookie: cookie } } : undefined,
    )
    if (!graphRes.ok) return []

    const graph = await graphRes.json()
    const hitSet = new Set(hitNoteIds)
    const neighbors = new Set()

    for (const edge of graph.edges) {
      if (hitSet.has(edge.source) && !hitSet.has(edge.target)) neighbors.add(edge.target)
      if (hitSet.has(edge.target) && !hitSet.has(edge.source)) neighbors.add(edge.source)
    }

    const neighborIds = [...neighbors].slice(0, neighborLimit)
    if (neighborIds.length === 0) return []

    // Fetch one representative chunk per neighbor from Supabase
    const inList = neighborIds.map((id) => `note_id.eq.${id}`).join(",")
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/chunks?or=(${encodeURIComponent(inList)})&order=chunk_index.asc&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          apikey: env.SUPABASE_SERVICE_KEY,
        },
      },
    )
    if (!res.ok) return []
    const rows = await res.json()

    // Annotate with graph node title for display
    return rows.map((row) => {
      const node = graph.nodes.find((n) => n.id === row.note_id)
      return { ...row, title: node?.title || row.title, is_neighbor: true }
    })
  } catch {
    return [] // graph expansion is always best-effort
  }
}

// ── Context assembly ─────────────────────────────────────────────────────────

export function assembleContext(topChunks, neighborChunks) {
  const parts = []

  topChunks.forEach((c, i) => {
    parts.push(`[${i + 1}] **${c.title}** (${c.type})\n${c.content}`)
  })

  if (neighborChunks.length > 0) {
    const neighborTitles = [...new Set(neighborChunks.map((c) => c.title))].join(", ")
    parts.push(`\n*Related notes via wikilinks (context only): ${neighborTitles}*`)
    neighborChunks.forEach((c) => {
      parts.push(`  — ${c.title}: ${c.content.slice(0, 300)}`)
    })
  }

  return parts.join("\n\n---\n\n")
}

// ── Main retrieve ────────────────────────────────────────────────────────────

/**
 * Full retrieval pipeline. Returns { context, sources } where:
 *   context  — assembled text to inject into LLM prompt
 *   sources  — array of {note_id, title, type, url} for display
 *
 * @param {string}  query       — raw user query (Hebrew or English)
 * @param {object}  env         — Cloudflare env bindings (AI, SUPABASE_URL, SUPABASE_SERVICE_KEY)
 * @param {string}  requestUrl  — request URL (for graph.json base path)
 * @param {object}  opts
 * @param {number}  opts.topK          — final chunks to feed LLM (default 8)
 * @param {number}  opts.candidates    — pre-rerank candidate pool (default 50)
 * @param {boolean} opts.skipExpand    — skip bilingual expansion (default false)
 * @param {boolean} opts.skipGraph     — skip graph expansion (default false)
 * @param {string}  opts.cookie        — caller's Cookie header, forwarded to same-origin fetches
 */
export async function retrieve(query, env, requestUrl, opts = {}) {
  const { topK = 8, candidates = 50, skipExpand = false, skipGraph = false, cookie = "" } = opts

  // 1. Bilingual expansion
  const expandedQuery = skipExpand ? query : await expandQueryBilingually(query, env.AI)

  // 2+3. Hybrid search (normal path); lexical text_search only on error.
  // Query and stored chunks share bge-m3 1024-dim (migration 0004), so the
  // dimensions match and pgvector dense search runs for real.
  let chunks = []
  try {
    const queryVec = await embedQuery(expandedQuery, env.AI)
    chunks = await hybridSearch(expandedQuery, queryVec, env, candidates)
  } catch (err) {
    console.warn("hybrid_search unavailable, falling back to text_search:", err.message)
    try {
      chunks = await textSearch(expandedQuery, env, candidates)
    } catch (err2) {
      console.error("text_search error:", err2)
      return { context: "", sources: [] }
    }
  }

  if (chunks.length === 0) return { context: "", sources: [] }

  // 4. Rerank → top-k
  const topChunks = await rerank(query, chunks, topK, env.AI)

  // 5. Graph expansion (best-effort)
  const hitNoteIds = [...new Set(topChunks.map((c) => c.note_id))]
  const neighborChunks = skipGraph ? [] : await expandGraph(hitNoteIds, requestUrl, env, 4, cookie)

  // 6. Assemble context
  const context = assembleContext(topChunks, neighborChunks)

  const sources = topChunks.map((c) => ({
    note_id: c.note_id,
    title: c.title,
    type: c.type,
    url: `/${c.note_id}`,
  }))

  return { context, sources }
}
