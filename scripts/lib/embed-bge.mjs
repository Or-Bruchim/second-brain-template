/**
 * Shared embedding helper — Cloudflare Workers AI bge-m3 (1024-dim, multilingual).
 *
 * Used by scripts/embed.mjs (documents) and scripts/promote.mjs (queries) so the
 * CI-side embeddings use the *exact same model* the worker and Pages functions use
 * at query time (`@cf/baai/bge-m3`). Document and query vectors must share a model
 * for `hybrid_search` (pgvector) to work — see supabase/migrations/0004.
 *
 * Required env vars (already present in CI as deploy secrets):
 *   CF_ACCOUNT_ID — Cloudflare account id
 *   CF_API_TOKEN  — token with Workers AI run permission
 */

const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env

const MODEL = "@cf/baai/bge-m3"

export const EMBED_DIM = 1024

export function assertEmbedEnv() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error(
      "Missing CF_ACCOUNT_ID or CF_API_TOKEN — required for bge-m3 embeddings via Workers AI",
    )
  }
}

/**
 * Embed an array of strings → array of 1024-dim float arrays (input order preserved).
 * bge-m3 is prefix-free — unlike e5, it needs no "query:"/"passage:" prefix.
 */
export async function embedTexts(texts) {
  assertEmbedEnv()
  if (!texts.length) return []

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: texts }),
      })
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Workers AI bge-m3 transient ${res.status}: ${await res.text()}`)
      }
      if (!res.ok) {
        throw new Error(`Workers AI bge-m3 failed (${res.status}): ${await res.text()}`)
      }
      const json = await res.json()
      const data = json?.result?.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(`Unexpected bge-m3 response: ${JSON.stringify(json).slice(0, 300)}`)
      }
      return data
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500))
    }
  }
  throw lastErr
}
