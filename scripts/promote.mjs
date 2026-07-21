#!/usr/bin/env node
/**
 * Promote new inbox captures into the wiki layer.
 *
 * Reads new files in content/inbox/, calls Gemini 2.5 Pro to plan
 * synthesis updates against the existing wiki, then applies file writes
 * to content/notes/, content/projects/, content/meetings/, content/decisions/,
 * updates content/catalog.md, and appends to content/log.md.
 *
 * Triggered by .github/workflows/promote.yml on push to content/inbox/**.
 *
 * Required env:
 *   GEMINI_API_KEY      Google AI Studio key (https://aistudio.google.com)
 * Optional env:
 *   PROMOTE_FILES               Comma-separated relative paths to promote.
 *                               Defaults to "git diff" against HEAD~1.
 *   GEMINI_MODEL                Primary model. Defaults to "gemini-2.5-flash".
 *   DRY_RUN                     "1" to skip writes (planning only).
 *   TELEGRAM_BOT_TOKEN          Bot token for quota-failure alerts.
 *   TELEGRAM_OWNER_CHAT_ID      Chat ID to send alerts to.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs"
import { execSync } from "child_process"
import { globby, globbySync } from "globby"
import matter from "gray-matter"
import path from "path"
import { embedTexts } from "./lib/embed-bge.mjs"

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  PROMOTE_FILES,
  BACKFILL,
  DRY_RUN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY")
  process.exit(1)
}

// Fallback chain tried in order when the primary model returns a quota error.
const GEMINI_FALLBACK_MODELS = ["gemini-2.0-flash-lite", "gemini-2.0-flash"]

const ROOT = process.cwd()
const CONTENT = path.join(ROOT, "content")
const INBOX = path.join(CONTENT, "inbox")
const CATALOG = path.join(CONTENT, "catalog.md")
const LOG = path.join(CONTENT, "log.md")

const WIKI_DIRS = ["notes", "projects", "meetings", "decisions"]
const MAX_INBOX_FILES_PER_RUN = 5
const MAX_RELEVANT_PAGES = 8

// ── Quartz/Obsidian syntax reference injected into every Gemini prompt ───
const QUARTZ_SYNTAX_REFERENCE = `
## Quartz / Obsidian Syntax Reference

### Wikilinks
[[notes/topic]]                  — basic internal link
[[notes/topic|Display Text]]     — aliased link (use when the slug is not human-readable)
![[notes/topic]]                 — inline embed of another note

### Callouts (use to surface key insights — don't overuse)
> [!note] Optional Title
> Content here

Available types: note, tip, info, warning, danger, success, question, example, quote
Collapsible: > [!note]- Title   (collapsed by default), > [!note]+ Title (expanded by default)

### Frontmatter — required fields and exact property names
title: "Human-readable title"
date: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [tag-one, tag-two]         # always lowercase-kebab-case
source: "promote"
sources: ["inbox/slug-here"]

### Tags — strict rules
- Always lowercase-kebab-case (no spaces, no camelCase, no uppercase)
- Good: ai-agents, product-management, book-notes, tool/claude
- Bad:  AIAgents, "Product Management", bookNotes, AI

### Headings
- Use ## and ### for sections — never # (the page title comes from frontmatter)

### Block IDs (use sparingly)
Append ^my-block-id to a paragraph to make it directly linkable.
Only for paragraphs worth citing elsewhere in the wiki.

### Writing style
- Hebrew text stays Hebrew; English technical terms stay English
- Prefer focused prose over long bullet lists for conceptual notes
- One concept per page — split if a page covers two distinct ideas
- No half-done pages: either write it properly or skip and note in log.md
`

// ── Detect inbox files to process ────────────────────────────────────────
function detectInboxFiles() {
  if (PROMOTE_FILES) {
    return PROMOTE_FILES.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (BACKFILL) return detectBacklog()
  try {
    const out = execSync("git diff --name-only --diff-filter=AM HEAD~1 HEAD -- content/inbox/", {
      encoding: "utf8",
    })
    return out
      .split("\n")
      .filter((p) => p.endsWith(".md"))
      .slice(0, MAX_INBOX_FILES_PER_RUN)
  } catch {
    console.log("No previous commit to diff against; nothing to promote.")
    return []
  }
}

// One-off connectivity backfill: pick inbox captures not yet handled, oldest
// first, up to BACKFILL_LIMIT (default 10) per run so quota and the review diff
// stay manageable. "Handled" = cited by a wiki page OR already logged in log.md
// (incl. no-op/failed attempts) — otherwise low-signal captures that legitimately
// synthesize to nothing would be re-picked every run and the loop would never
// drain. Re-run until it reports 0 remaining.
function detectBacklog() {
  const limit = parseInt(process.env.BACKFILL_LIMIT || "10", 10)
  const scanned = globbySync(
    WIKI_DIRS.map((d) => `${d}/**/*.md`).concat("catalog.md", "journal/**/*.md", "log.md"),
    { cwd: CONTENT },
  )
    .map((rel) => readFileSync(path.join(CONTENT, rel), "utf8"))
    .join("\n")
  const handled = new Set([...scanned.matchAll(/inbox\/[0-9a-z-]+/g)].map((m) => m[0]))
  const all = globbySync("inbox/*.md", { cwd: CONTENT }).sort()
  const backlog = all.filter((rel) => !handled.has(rel.replace(/\.md$/, "")))
  console.log(
    `backfill: ${backlog.length} unhandled inbox file(s) remaining; promoting ${Math.min(limit, backlog.length)} this run.`,
  )
  return backlog.slice(0, limit).map((rel) => `content/${rel}`)
}

// ── Build a lightweight index of the existing wiki ───────────────────────
async function buildWikiIndex() {
  const pages = []
  for (const dir of WIKI_DIRS) {
    const full = path.join(CONTENT, dir)
    if (!existsSync(full)) continue
    const files = await globby([`${dir}/**/*.md`], { cwd: CONTENT })
    for (const rel of files) {
      const text = readFileSync(path.join(CONTENT, rel), "utf8")
      const { data, content } = matter(text)
      pages.push({
        path: rel,
        slug: rel.replace(/\.md$/, ""),
        title: data.title || path.basename(rel, ".md"),
        tags: data.tags || [],
        updated: data.updated || data.date || null,
        excerpt: content.replace(/\s+/g, " ").trim().slice(0, 280),
      })
    }
  }
  return pages
}

// ── Semantic relevance via Supabase hybrid search ────────────────────────
// Embeds the capture with the same model embed.mjs uses for documents
// (Workers AI bge-m3, 1024-dim, prefix-free) and asks the hybrid_search RPC for
// the closest chunks. Falls back to keyword overlap when Supabase/CF env or the
// model is unavailable.
async function retrieveRelevantPages(inboxText, pages) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return rankRelevantPages(inboxText, pages)
  try {
    const [embedding] = await embedTexts([inboxText.slice(0, 2000)])

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hybrid_search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_text: inboxText.slice(0, 2000),
        query_embedding: embedding,
        match_count: 30,
      }),
    })
    if (!res.ok) throw new Error(`hybrid_search ${res.status}: ${await res.text()}`)
    const rows = await res.json()

    const bySlug = new Map(pages.map((p) => [p.slug, p]))
    const hits = []
    const seen = new Set()
    for (const row of rows) {
      if (seen.has(row.note_id)) continue
      seen.add(row.note_id)
      const page = bySlug.get(row.note_id)
      if (page) hits.push(page)
      if (hits.length >= MAX_RELEVANT_PAGES) break
    }
    // Top up with keyword-ranked pages so the prompt always has candidates
    if (hits.length < MAX_RELEVANT_PAGES) {
      for (const p of rankRelevantPages(inboxText, pages)) {
        if (!hits.some((h) => h.slug === p.slug)) hits.push(p)
        if (hits.length >= MAX_RELEVANT_PAGES) break
      }
    }
    console.log(
      `  relevance: hybrid search matched ${seen.size} notes, ${hits.length} candidates for prompt`,
    )
    return hits
  } catch (err) {
    console.warn(`  relevance: hybrid search unavailable (${err.message}) — keyword fallback`)
    return rankRelevantPages(inboxText, pages)
  }
}

// ── Score wiki pages by overlap with inbox content ───────────────────────
function rankRelevantPages(inboxText, pages) {
  const tokens = new Set(inboxText.toLowerCase().match(/[a-z0-9֐-׿]{3,}/g) || [])
  return pages
    .map((p) => {
      const haystack = `${p.title} ${(p.tags || []).join(" ")} ${p.excerpt}`.toLowerCase()
      const ht = new Set(haystack.match(/[a-z0-9֐-׿]{3,}/g) || [])
      let score = 0
      for (const t of tokens) if (ht.has(t)) score++
      return { ...p, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_PAGES)
}

// ── Build the Gemini prompt ──────────────────────────────────────────────
function buildPrompt({ inboxPath, inboxData, inboxBody, relevantPages, allTitles, mocs }) {
  return `You are the wiki maintainer for Second Brain — a personal knowledge base built on Quartz.

You just received a new raw capture in content/inbox/. Your job: integrate it into the wiki layer (content/notes, projects, meetings, decisions) by extracting entities/concepts, updating existing pages where they apply, and creating new pages where they don't yet exist.

Read CLAUDE.md for the full schema. Key rules:
- Never modify the inbox file. It is immutable.
- Wiki pages have YAML frontmatter (title, date, updated, tags, source, sources).
- Tags MUST come from this closed taxonomy (others are stripped at write time): type tags (exactly one): note, meeting, decision, project, journal, synthesis, meta; domain tags (zero or more): ai, product, design, engineering, personal, health, reading, business; entity tags (zero or more): person/{slug}, company/{slug}, tool/{slug}.
- Sources list MUST cite the inbox slug as a wikilink target string, e.g. "inbox/2026-04-30-1779000000000".
- Use Obsidian wikilinks for cross-references: [[notes/transformer-architecture]].
- One concept per page. Match the templates in content/templates/.
- Hebrew content stays Hebrew.
- Prefer extending existing pages over creating new ones.
- A promote that just files a copy of the raw capture is a failure — that's RAG, not a wiki. Only create or update a page when you can genuinely synthesize: extract an entity/concept, connect it to existing pages, or add a new fact to one.
- If the capture has no substantive content to synthesize (e.g. a bare URL with no context, an empty stub), return an EMPTY operations list with a summary explaining why. The capture will stay in the inbox as pending — that is the correct outcome, not a failure.

CONNECTIVITY RULES (the graph is only as good as its links — follow these strictly):
- Every wiki page you create or update MUST contain 3–5 body wikilinks to OTHER existing wiki pages (from the relevant/known lists below), woven into the prose. A page with fewer than 3 links to existing pages is incomplete.
- Each link must be earned by the surrounding sentence — link a concept where you actually discuss it, never a bare "Related: [[a]] [[b]]" list at the bottom and never a link whose only justification is "both are about AI".
- Only link to slugs that appear in the relevant-pages or known-titles lists below, or to a page you are creating in this same operation set. Do NOT invent [[Concept]] links to pages that don't exist — that creates dead nodes.
- Always cite the inbox source via a [[inbox/...]] wikilink in a "## Sources" section, in addition to the sources: frontmatter.
- MOCs (Maps of Content) are the hub pages named notes/moc-*. Pick the ONE most relevant MOC for this capture and add an "update" operation that inserts an annotated link to your new/updated page under the right section of that MOC (one line: "- [[notes/slug]] — what it is"). If no MOC fits, skip this; do not force it.

INBOX FILE: content/${inboxPath}
INBOX FRONTMATTER:
${JSON.stringify(inboxData, null, 2)}

INBOX BODY:
${inboxBody.slice(0, 8000)}

EXISTING WIKI PAGES MOST LIKELY TO BE RELEVANT (top ${relevantPages.length} by semantic similarity):
${relevantPages.map((p) => `- ${p.path} | title: "${p.title}" | tags: [${(p.tags || []).join(", ")}] | excerpt: "${p.excerpt}"`).join("\n") || "(none — wiki is empty or no overlap)"}

MAPS OF CONTENT (hub pages — add your page to the most relevant one via an "update" op with the COMPLETE new file content; never drop existing entries):
${mocs && mocs.length ? mocs.map((m) => `### ${m.path}\n${m.body}`).join("\n\n") : "(none yet)"}

ALL EXISTING WIKI PAGE TITLES (for awareness):
${allTitles.length ? allTitles.join(", ") : "(none)"}

Decide what to do. Return JSON matching the schema. For each operation:
- "create": new wiki page. Provide full markdown content INCLUDING YAML frontmatter. The frontmatter MUST include: title, date (today: ${new Date().toISOString().slice(0, 10)}), updated (today), tags (array), source: "promote", sources (array of wikilink target strings, must include the inbox slug). The body MUST weave in 3–5 wikilinks to existing pages.
- "update": existing wiki page. Provide the COMPLETE NEW FILE CONTENT (frontmatter + body). Bump "updated" to today. Append the inbox slug to "sources" if not present. Keep narrative cohesion — don't just append bullets at the bottom. Preserve/strengthen its links to other pages.
- Provide a "summary" string for log.md (one line, what changed and why).

Return an empty operations list when there is nothing substantive to synthesize.
${QUARTZ_SYNTAX_REFERENCE}`
}

// ── Gemini structured-output schema ──────────────────────────────────────
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One-line summary for log.md" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update"] },
          path: {
            type: "string",
            description: 'Relative to content/, e.g. "notes/transformer-architecture.md"',
          },
          content: { type: "string", description: "Full file content including YAML frontmatter" },
          rationale: { type: "string", description: "One sentence — why this op" },
        },
        required: ["action", "path", "content", "rationale"],
      },
    },
  },
  required: ["summary", "operations"],
}

// ── Check if an error is a quota/rate-limit error ────────────────────────
function isQuotaError(err) {
  return err.message.includes("429") || err.message.toLowerCase().includes("quota")
}

// ── Send a Telegram alert (best-effort, never throws) ────────────────────
async function notifyTelegram(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_OWNER_CHAT_ID,
        text,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    })
  } catch (e) {
    console.warn("  could not send Telegram alert:", e.message)
  }
}

// Human-in-the-loop: report what a promote run wrote, with a delete button
// per page (the worker's existing `del:<slug>` callback handles the press).
async function notifyPromoteResult(written) {
  if (!written.length) return
  const siteUrl = process.env.SITE_URL || "https://your-project.pages.dev"
  const lines = ["🧠 <b>promote עדכן את הוויקי:</b>", ""]
  for (const op of written) {
    const slug = op.path.replace(/\.md$/, "")
    lines.push(
      `• ${op.action === "create" ? "נוצר" : "עודכן"} <a href="${siteUrl}/${slug}">${slug}</a>`,
    )
  }
  const buttons = written
    .slice(0, 4)
    .map((op) => op.path.replace(/\.md$/, ""))
    .filter((slug) => `del:${slug}`.length <= 64) // Telegram callback_data hard limit
    .map((slug) => [{ text: `🗑 ${slug.slice(0, 40)}`, callback_data: `del:${slug}` }])
  await notifyTelegram(lines.join("\n"), buttons.length ? { inline_keyboard: buttons } : undefined)
}

// ── Call a specific Gemini model ─────────────────────────────────────────
async function callGemini(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 500)}`)
  const json = await r.json()
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Gemini empty response: ${JSON.stringify(json).slice(0, 500)}`)
  return JSON.parse(text)
}

// ── Try primary model then fallbacks on quota errors ─────────────────────
async function callWithFallback(prompt) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)]
  let lastErr
  for (const model of models) {
    try {
      const result = await callGemini(prompt, model)
      if (model !== GEMINI_MODEL) console.log(`  succeeded with fallback model: ${model}`)
      return result
    } catch (err) {
      if (isQuotaError(err)) {
        console.warn(`  quota exceeded for ${model}, trying next...`)
        lastErr = err
        continue
      }
      throw err
    }
  }
  await notifyTelegram(
    `<b>Second Brain — promote נכשל</b>\n\nQuota נגמרה על כל מודלי Gemini:\n${models.join(", ")}\n\nקבצי inbox חדשים לא עובדו. נא לחדש את ה-API key:\nhttps://aistudio.google.com/app/apikey`,
  )
  throw lastErr
}

// ── Living overview — one-page synthesis of the whole wiki ───────────────
// Regenerated after every promote run that actually wrote pages, so the
// overview always reflects current cross-source state (the "living overview"
// idea from the LLM-wiki pattern).
async function callGeminiText(prompt) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)]
  let lastErr
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 },
        }),
      })
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`)
      const json = await r.json()
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error("Gemini empty response")
      return text.trim()
    } catch (err) {
      if (isQuotaError(err)) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr
}

async function rebuildOverview() {
  if (DRY_RUN === "1") return
  const pages = await buildWikiIndex()
  if (pages.length < 5) return // not enough material for a meaningful overview
  const today = new Date().toISOString().slice(0, 10)
  const listing = pages
    .map(
      (p) =>
        `- ${p.slug} | "${p.title}" | tags: [${(p.tags || []).join(", ")}] | ${p.excerpt.slice(0, 160)}`,
    )
    .join("\n")
  const prompt = `You maintain content/overview.md — the living overview page of Second Brain, a personal knowledge wiki.

Below is the full index of wiki pages (slug | title | tags | excerpt). Write the BODY of the overview page (markdown, no frontmatter):

${listing}

Requirements:
- Write primarily in Hebrew. Tool/brand/person names stay in English.
- 250-400 words. Sections: "## תמות מרכזיות" (the 3-5 main knowledge clusters), "## חיבורים מעניינים" (non-obvious connections between pages), "## כיוון אחרון" (what the recent pages suggest the user is focused on).
- Reference pages with wikilinks like [[notes/claude-code]] — only slugs that appear in the index above.
- Base every claim only on the excerpts above. No invented facts.
- This page is regenerated automatically — do not address the reader, no preamble, no closing notes.`
  const body = await callGeminiText(prompt)
  const fm = `---
title: "Overview"
date: ${today}
updated: ${today}
tags: ["meta"]
source: "synthesis"
---

> נבנה אוטומטית אחרי כל promote — תמונת מצב חיה של המוח. אל תערוך ידנית.

`
  writeFileSync(path.join(CONTENT, "overview.md"), fm + body + "\n")
  console.log("overview.md regenerated")
}

// ── Validate path is inside the wiki layer ───────────────────────────────
function validateOpPath(p) {
  let norm = path.normalize(p).replace(/^\/+/, "")
  if (
    norm.startsWith("inbox/") ||
    norm.startsWith("templates/") ||
    norm === "index.md" ||
    norm === "activity.md" ||
    norm === "log.md" ||
    norm === "catalog.md" ||
    norm === "overview.md"
  ) {
    throw new Error(`refused: promote may not write to ${norm}`)
  }
  // The LLM sometimes emits entity-tag-style paths (person/x, company/x, tool/x);
  // those are concept pages and belong under notes/.
  if (/^(person|company|tool)\//.test(norm)) norm = "notes/" + norm
  if (!WIKI_DIRS.some((d) => norm.startsWith(d + "/"))) {
    throw new Error(`refused: ${norm} is not in a wiki folder (${WIKI_DIRS.join(", ")})`)
  }
  if (!norm.endsWith(".md")) throw new Error(`refused: ${norm} must end with .md`)
  return norm
}

// Guard against degenerate model output: a wiki page must have parseable YAML
// frontmatter (with a title) and a non-empty body. Catches the newline-free
// single-line blobs weak fallback models sometimes emit.
function isWellFormedPage(content) {
  if (typeof content !== "string" || !content.trim()) return false
  let parsed
  try {
    parsed = matter(content)
  } catch {
    return false
  }
  if (!parsed.data || !parsed.data.title) return false
  if (!parsed.content || !parsed.content.trim()) return false
  return true
}

// ── Apply ops ────────────────────────────────────────────────────────────
// ── Tag taxonomy (CLAUDE.md) — enforced at write time ────────────────────
const TYPE_TAGS = ["note", "meeting", "decision", "project", "journal", "synthesis", "meta"]
const DOMAIN_TAGS = [
  "ai",
  "product",
  "design",
  "engineering",
  "personal",
  "health",
  "reading",
  "business",
]
const ENTITY_TAG_RE = /^(person|company|tool)\/[a-z0-9-]+$/

// Filters frontmatter tags to the CLAUDE.md taxonomy. Unknown tags are
// dropped (this is what caused the 75+ tag drift); a missing type tag
// defaults to "note". Returns the content unchanged when it has no
// parseable frontmatter or no tags.
function enforceTaxonomy(content, rel) {
  let parsed
  try {
    parsed = matter(content)
  } catch {
    return content
  }
  const tags = parsed.data?.tags
  if (!Array.isArray(tags)) return content
  const kept = tags
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => TYPE_TAGS.includes(t) || DOMAIN_TAGS.includes(t) || ENTITY_TAG_RE.test(t))
  const dropped = tags.filter((t) => !kept.includes(String(t).toLowerCase().trim()))
  if (!kept.some((t) => TYPE_TAGS.includes(t))) kept.unshift("note")
  if (dropped.length) console.warn(`  ⚠ ${rel}: dropped off-taxonomy tags [${dropped.join(", ")}]`)
  if (!dropped.length && kept.length === tags.length) return content
  return matter.stringify(parsed.content, { ...parsed.data, tags: [...new Set(kept)] })
}

function applyOps(plan, inboxSlug) {
  const written = []
  for (const op of plan.operations || []) {
    let rel
    try {
      rel = validateOpPath(op.path)
    } catch (err) {
      // A single refused/bad path must not abort the whole run (esp. backfill
      // batches) — skip this op and keep going.
      console.warn(`  ⚠ skip op — ${err.message}`)
      continue
    }
    const full = path.join(CONTENT, rel)
    if (op.action === "create" && existsSync(full)) {
      console.warn(`  ⚠ skip create — file exists: ${rel}`)
      continue
    }
    if (op.action === "update" && !existsSync(full)) {
      console.warn(`  ⚠ skip update — file missing: ${rel}`)
      continue
    }
    // Reject malformed content before it lands. Weak fallback models have
    // returned single-line, newline-free blobs with unparseable frontmatter —
    // skip those rather than corrupt a page (especially destructive on update).
    if (!isWellFormedPage(op.content)) {
      console.warn(
        `  ⚠ skip ${op.action} — malformed content (no parseable frontmatter / no body): ${rel}`,
      )
      continue
    }
    if (DRY_RUN === "1") {
      console.log(`  [dry] ${op.action.padEnd(6)} ${rel} — ${op.rationale}`)
      continue
    }
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, enforceTaxonomy(op.content, rel))
    written.push({ action: op.action, path: rel, rationale: op.rationale })
    console.log(`  ✓ ${op.action.padEnd(6)} ${rel} — ${op.rationale}`)
  }
  return written
}

// ── Append to log.md ─────────────────────────────────────────────────────
function appendLog(entries) {
  if (DRY_RUN === "1" || entries.length === 0) return
  const now = new Date()
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  let block = ""
  for (const e of entries) {
    block += `\n## [${ts}] promote | ${e.summary}\n`
    for (const op of e.written) {
      block += `- ${op.action} \`${op.path}\` — ${op.rationale}\n`
    }
  }
  let existing = existsSync(LOG)
    ? readFileSync(LOG, "utf8")
    : '---\ntitle: Log\ntags: ["meta"]\n---\n\n> Append-only chronological log of wiki operations. Maintained by promote.mjs and lint-wiki.mjs.\n'
  writeFileSync(LOG, existing + block)
}

// ── Rebuild catalog.md ───────────────────────────────────────────────────
async function rebuildCatalog() {
  if (DRY_RUN === "1") return
  const today = new Date().toISOString().slice(0, 10)
  const sections = {
    Notes: [],
    Projects: [],
    Meetings: [],
    Decisions: [],
    Synthesis: [],
    Lint: [],
  }
  const journals = []

  const all = await globby(
    [
      "notes/**/*.md",
      "projects/**/*.md",
      "meetings/**/*.md",
      "decisions/**/*.md",
      "journal/**/*.md",
      "lint/**/*.md",
    ],
    { cwd: CONTENT },
  )
  for (const rel of all) {
    const text = readFileSync(path.join(CONTENT, rel), "utf8")
    const { data, content } = matter(text)
    const slug = rel.replace(/\.md$/, "")
    const title = data.title || path.basename(rel, ".md")
    const summary = (
      content
        .replace(/^#+.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || ""
    ).replace(/\|/g, "\\|")

    if (rel.startsWith("notes/synthesis/")) sections.Synthesis.push({ slug, title, summary })
    else if (rel.startsWith("notes/")) sections.Notes.push({ slug, title, summary })
    else if (rel.startsWith("projects/")) sections.Projects.push({ slug, title, summary })
    else if (rel.startsWith("meetings/")) sections.Meetings.push({ slug, title, summary })
    else if (rel.startsWith("decisions/")) sections.Decisions.push({ slug, title, summary })
    else if (rel.startsWith("journal/"))
      journals.push({ slug, title, summary, date: data.date || path.basename(rel, ".md") })
    else if (rel.startsWith("lint/"))
      sections.Lint.push({ slug, title, summary, date: data.date || path.basename(rel, ".md") })
  }

  for (const k of ["Notes", "Projects"]) sections[k].sort((a, b) => a.title.localeCompare(b.title))
  for (const k of ["Meetings", "Decisions", "Synthesis"])
    sections[k].sort((a, b) => b.slug.localeCompare(a.slug))
  sections.Lint.sort((a, b) => b.slug.localeCompare(a.slug))
  const dateKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || ""))
  journals.sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)))

  let md = `---\ntitle: Catalog\ntags: ["meta"]\nupdated: ${today}\n---\n\n> Auto-maintained by promote.mjs / lint-wiki.mjs. Don't edit by hand — it'll be overwritten.\n`
  for (const [name, items] of Object.entries(sections)) {
    if (items.length === 0) continue
    md += `\n## ${name}\n`
    for (const it of items) md += `- [[${it.slug}]] — ${it.summary || it.title}\n`
  }
  if (journals.length) {
    md += `\n## Journal (recent)\n`
    for (const it of journals.slice(0, 10)) md += `- [[${it.slug}]] — ${it.summary || it.title}\n`
  }
  writeFileSync(CATALOG, md)
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const inboxFiles = detectInboxFiles()
  if (inboxFiles.length === 0) {
    console.log("No inbox files to promote.")
    return
  }
  console.log(
    `Promoting ${inboxFiles.length} inbox file(s) with model ${GEMINI_MODEL} (fallbacks: ${GEMINI_FALLBACK_MODELS.join(", ")})...`,
  )

  const wikiPages = await buildWikiIndex()
  const allTitles = wikiPages.map((p) => p.title).slice(0, 100)
  // MOCs are small hub pages; carry their FULL body so the LLM can rewrite one
  // without truncating existing entries (it returns complete file content).
  const mocs = wikiPages
    .filter((p) => p.slug.startsWith("notes/moc-"))
    .map((p) => ({ ...p, body: readFileSync(path.join(CONTENT, p.path), "utf8") }))
  const entries = []

  for (const rel of inboxFiles) {
    const full = path.join(ROOT, rel)
    if (!existsSync(full) || !rel.startsWith("content/inbox/")) {
      console.warn(`Skip ${rel} — not an inbox file or missing.`)
      continue
    }
    const text = readFileSync(full, "utf8")
    const { data, content } = matter(text)
    const inboxRel = rel.replace(/^content\//, "")
    const inboxSlug = inboxRel.replace(/\.md$/, "")

    console.log(`\n→ ${rel}`)

    // Stub awaiting user context from Telegram — skip; promote re-runs when
    // the bot commits the context reply and removes the status.
    if (data.status === "pending-context") {
      console.log("  skipped — pending-context stub, waiting for user reply")
      continue
    }

    // Gemini synthesis — find/create/update concept notes
    const relevant = await retrieveRelevantPages(content, wikiPages)
    const prompt = buildPrompt({
      inboxPath: inboxRel,
      inboxData: data,
      inboxBody: content,
      relevantPages: relevant,
      allTitles,
      mocs,
    })

    let plan
    try {
      plan = await callWithFallback(prompt)
    } catch (err) {
      console.error(`  synthesis failed: ${err.message}`)
      entries.push({
        summary: `synthesis failed — [[${inboxSlug}]] left unpromoted: ${err.message.slice(0, 120)}`,
        written: [],
      })
      continue
    }
    console.log(`  synthesis: ${plan.summary}`)
    const written = applyOps(plan, inboxSlug)
    if (written.length) {
      entries.push({ summary: plan.summary, written })
      if (DRY_RUN !== "1") await notifyPromoteResult(written)
    } else {
      entries.push({
        summary: `no-op — [[${inboxSlug}]] left unpromoted: ${plan.summary}`,
        written: [],
      })
    }
  }

  try {
    appendLog(entries)
  } catch (e) {
    console.error("appendLog failed:", e.message)
  }
  try {
    await rebuildCatalog()
  } catch (e) {
    console.error("rebuildCatalog failed:", e.message)
  }
  if (entries.some((e) => e.written.length)) {
    try {
      await rebuildOverview()
    } catch (e) {
      console.error("rebuildOverview failed:", e.message)
    }
  }
  console.log(`\nDone. ${entries.length} promote run(s).`)
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
