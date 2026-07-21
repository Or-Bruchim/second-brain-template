#!/usr/bin/env node
/**
 * Embedding pipeline — triggered by GitHub Actions on content changes.
 * Chunks content/*.md, generates embeddings via Cloudflare Workers AI (bge-m3),
 * and upserts rows to Supabase (pgvector).
 *
 * Embeds with @cf/baai/bge-m3 (1024-dim) — the same model the worker and Pages
 * functions use at query time, so document and query vectors share a space and
 * hybrid_search actually matches (see supabase/migrations/0004).
 *
 * Required env vars:
 *   SUPABASE_URL         — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role JWT (server-side only)
 *   CF_ACCOUNT_ID        — Cloudflare account id (Workers AI)
 *   CF_API_TOKEN         — token with Workers AI run permission
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { globby } from "globby"
import matter from "gray-matter"
import { embedTexts, assertEmbedEnv } from "./lib/embed-bge.mjs"

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
  process.exit(1)
}
assertEmbedEnv()

const CHUNK_WORDS = 400
const CHUNK_OVERLAP = 50
const IGNORED = [".obsidian", "templates", "attachments", "private"]
const MANIFEST_PATH = "quartz/static/kg/manifest.json"

// ── Supabase REST helpers ────────────────────────────────────────────────────

const sbHeaders = {
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  apikey: SUPABASE_SERVICE_KEY,
  "Content-Type": "application/json",
}

async function sbUpsertChunks(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase upsert failed (${res.status}): ${err}`)
  }
}

async function sbDeleteByNoteId(noteId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chunks?note_id=eq.${encodeURIComponent(noteId)}`,
    { method: "DELETE", headers: sbHeaders },
  )
  if (!res.ok) {
    const err = await res.text()
    console.warn(`  Supabase delete warning for ${noteId} (${res.status}): ${err}`)
  }
}

// ── Content helpers ──────────────────────────────────────────────────────────

function noteId(filePath) {
  return filePath.replace(/^content\//, "").replace(/\.md$/, "")
}

function noteType(id) {
  const parts = id.split("/")
  return parts.length > 1 ? parts[0] : "root"
}

function cleanMarkdown(content) {
  return content
    .replace(
      /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
      (_, target, alias) => alias || target,
    )
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^---[\s\S]*?---/, "")
    .trim()
}

function chunkContent(content) {
  const text = cleanMarkdown(content)
  if (!text) return []
  const sections = text.split(/(?=\n#{2,3} )/)
  const chunks = []
  for (const section of sections) {
    const words = section.split(/\s+/).filter(Boolean)
    if (words.length <= CHUNK_WORDS) {
      const chunk = section.trim()
      if (chunk.length > 50) chunks.push(chunk)
    } else {
      for (let i = 0; i < words.length; i += CHUNK_WORDS - CHUNK_OVERLAP) {
        const chunk = words
          .slice(i, i + CHUNK_WORDS)
          .join(" ")
          .trim()
        if (chunk.length > 50) chunks.push(chunk)
      }
    }
  }
  // Guarantee: any note with content gets at least one chunk, even bare links
  // or one-liners shorter than 50 chars. Nothing the user sent is dropped.
  if (chunks.length === 0 && text.length > 0) chunks.push(text)
  return chunks
}

function enrichForEmbedding(chunk, title, type) {
  return `[${title} · ${type}]\n${chunk}`
}

// ── Manifest ─────────────────────────────────────────────────────────────────

function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  } catch {
    return {}
  }
}

function saveManifest(manifest) {
  const dir = MANIFEST_PATH.split("/").slice(0, -1).join("/")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const files = await globby("content/**/*.md", {
    ignore: IGNORED.map((d) => `content/${d}/**`),
  })

  const currentIds = new Set(files.map(noteId))
  const manifest = loadManifest()

  // Clean up deleted notes
  const deletedIds = Object.keys(manifest).filter((id) => !currentIds.has(id))
  if (deletedIds.length > 0) {
    console.log(`Cleaning ${deletedIds.length} deleted note(s)...`)
    for (const id of deletedIds) {
      await sbDeleteByNoteId(id)
      delete manifest[id]
    }
  }

  let totalChunks = 0

  for (const file of files) {
    const raw = readFileSync(file, "utf8")
    const { data: fm, content } = matter(raw)
    if (fm.draft) continue

    const id = noteId(file)
    const type = noteType(id)
    const title = fm.title || file.split("/").pop().replace(".md", "")
    const tags = fm.tags || []
    const chunks = chunkContent(content)
    if (chunks.length === 0) continue

    if (manifest[id] !== undefined) await sbDeleteByNoteId(id)

    // Embed in batches of 10 (local model processes sequentially)
    for (let i = 0; i < chunks.length; i += 10) {
      const batch = chunks.slice(i, i + 10)
      const enrichedBatch = batch.map((c) => enrichForEmbedding(c, title, type))
      const embeddings = await embedTexts(enrichedBatch)

      const rows = batch.map((chunkText, j) => ({
        id: `${id.replace(/\//g, "__")}__${i + j}`,
        note_id: id,
        title,
        type,
        chunk_index: i + j,
        chunk_total: chunks.length,
        content: chunkText,
        tags,
        embedding: embeddings[j],
      }))

      await sbUpsertChunks(rows)
      totalChunks += rows.length
    }

    manifest[id] = chunks.length
    process.stdout.write(`  ${id} (${chunks.length} chunks)\n`)
  }

  saveManifest(manifest)
  console.log(
    `\nDone — ${totalChunks} chunks upserted, ${Object.keys(manifest).length} notes tracked`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
