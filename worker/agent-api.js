// Agent HTTP API — a clean JSON surface over the brain for an external agent
// (e.g. the Pedri agent Worker). All routes require:
//   Authorization: Bearer <AGENT_TOKEN>
//
// Endpoints:
//   POST /ingest   { text, urls?, tags?, whySaved?, whenToApply?, kind?, folder?, title?, summary?, force? }
//                  → { duplicate:true, existing } when a urls[] entry was saved before (unless force:true)
//   POST /search   { query, limit? }
//   POST /ask      { question, history? }
//   POST /recent   { limit? }
//   POST /delete   { slug }
//
// The existing Telegram pipeline in handlers.js is untouched; this module reuses
// the same low-level helpers (commitFile, upsertVector, retrieveRelevantNotes,
// analyzeWithAI, fetchRichMeta, appendActivityLog).

import { parseFrontmatterForReport } from "./digest.js"
import { appendActivityLog } from "./handlers.js"
import { commitFile, deleteNote, triggerDeploy } from "./github.js"
import { analyzeWithAI, fetchRichMeta } from "./media.js"
import { expandQueryBilingually, retrieveRelevantNotes, upsertVector } from "./retrieve.js"
import { decodeGithubContent, escapeHtmlTg, jsonResponse, simpleHash } from "./util.js"

const VALID_FOLDERS = new Set(["inbox", "journal", "recipes"])

function authOk(request, env) {
  if (!env.AGENT_TOKEN) return null // signal "not configured"
  const header = request.headers.get("Authorization") || ""
  return header === `Bearer ${env.AGENT_TOKEN}`
}

function guard(request, env) {
  const ok = authOk(request, env)
  if (ok === null) return jsonResponse({ error: "AGENT_TOKEN not configured on this Worker" }, 503)
  if (!ok) return jsonResponse({ error: "Unauthorized" }, 401)
  return null
}

// ── POST /ingest ─────────────────────────────────────────────────────────────
export async function handleAgentIngest(request, env) {
  const denied = guard(request, env)
  if (denied) return denied

  let body
  try { body = await request.json() } catch { return jsonResponse({ error: "Bad JSON" }, 400) }

  const text = (body.text || "").trim()
  const urls = Array.isArray(body.urls) ? body.urls.filter(u => typeof u === "string") : []
  if (!text && urls.length === 0) return jsonResponse({ error: "Provide text or urls" }, 400)

  const folder = VALID_FOLDERS.has(body.folder) ? body.folder : "inbox"
  const kind = body.kind || (urls.length ? "link" : "text")
  const providedTags = Array.isArray(body.tags) ? body.tags.map(String) : []

  const now = new Date()
  const dateStr = now.toISOString().split("T")[0]
  const bareSlug = `${dateStr}-${now.getTime()}`
  const slug = `${folder}/${bareSlug}`

  try {
    // Duplicate-URL guard (mirrors the Telegram path). The dedup index lives in
    // this Worker's KV, so the check has to happen here. Caller passes
    // force:true to save anyway.
    if (urls.length && env.BRAIN_KV && body.force !== true) {
      for (const u of urls) {
        const existing = await env.BRAIN_KV.get(`url_idx:${simpleHash(u)}`, "json")
        if (existing) {
          return jsonResponse({ duplicate: true, url: u, existing })
        }
      }
    }

    const richUrls = await Promise.all(urls.map(u => fetchRichMeta(u, env)))

    // Enrich only what the caller didn't supply.
    let ai = {
      title: body.title || "",
      summary: body.summary || "",
      tags: providedTags,
      whySaved: body.whySaved || "",
      whenToApply: body.whenToApply || "",
      keyPoints: [],
    }
    if (!ai.title || !ai.summary) {
      const auto = await analyzeWithAI(
        { userNote: text, hashtags: providedTags, richUrls, hasImage: false, imageVision: {} },
        env,
      )
      ai = {
        title: ai.title || auto.title,
        summary: ai.summary || auto.summary,
        tags: [...new Set([...providedTags, ...auto.tags])],
        whySaved: ai.whySaved || auto.whySaved,
        whenToApply: ai.whenToApply || auto.whenToApply,
        keyPoints: auto.keyPoints || [],
      }
    }

    const allTags = [...new Set([folder === "inbox" ? "inbox" : folder, "agent", kind, ...ai.tags])]

    const bodyParts = []
    if (ai.summary) bodyParts.push(`> ${ai.summary}`, "")
    for (const r of richUrls) {
      bodyParts.push(`## [${r.title || r.url}](${r.url})`)
      if (r.author) bodyParts.push(`**By:** ${r.author}`)
      if (r.description) bodyParts.push("", r.description)
      if (r.keyPoints?.length) { bodyParts.push(""); r.keyPoints.forEach(p => bodyParts.push(p)) }
      bodyParts.push("")
    }
    if (text) bodyParts.push(`**Note:** ${text}`, "")
    if (ai.whySaved) bodyParts.push(`**Why saved:** ${ai.whySaved}`)
    if (ai.whenToApply) bodyParts.push(`**When to apply:** ${ai.whenToApply}`)

    const frontmatter = [
      "---",
      `title: "${ai.title.replace(/"/g, "'")}"`,
      `date: ${dateStr}`,
      `tags: [${allTags.map(t => `"${t}"`).join(", ")}]`,
      `source: agent`,
      richUrls.length ? `url: "${richUrls[0].url}"` : "",
      folder === "journal" ? `type: journal` : "",
      ai.whenToApply ? `when_to_apply: "${ai.whenToApply.replace(/"/g, "'")}"` : "",
      "---",
    ].filter(Boolean).join("\n")

    const fullContent = frontmatter + "\n\n" + bodyParts.join("\n") + "\n"
    await commitFile(`content/${slug}.md`, fullContent, `agent: ${ai.title}`, env, false, true)

    const embedText = [
      ai.title, ai.title, ai.summary, allTags.join(" "), text,
      ai.keyPoints?.join(" "),
      richUrls.map(r => [r.title, r.description].filter(Boolean).join(" ")).join(" "),
    ].filter(Boolean).join(" ").slice(0, 2000)

    const siteUrl = env.SITE_URL || "https://your-project.pages.dev"
    const noteUrl = `${siteUrl}/${slug}`

    await Promise.all([
      upsertVector(slug, embedText, { title: ai.title, tags: allTags }, env),
      appendActivityLog({ from: "Agent", kind, title: ai.title, slug, env }),
      triggerDeploy(env),
    ])

    // URL dedup index (mirrors the Telegram path) — best effort.
    if (urls.length && env.BRAIN_KV) {
      for (const u of urls) {
        env.BRAIN_KV.put(
          `url_idx:${simpleHash(u)}`,
          JSON.stringify({ slug, title: ai.title, noteUrl }),
          { expirationTtl: 365 * 86400 },
        ).catch(() => {})
      }
    }

    return jsonResponse({
      slug,
      noteUrl,
      title: ai.title,
      summary: ai.summary,
      tags: allTags.filter(t => t !== "inbox"),
    })
  } catch (err) {
    console.error("handleAgentIngest error:", err)
    return jsonResponse({ error: "Ingest failed", detail: String(err?.message || err) }, 500)
  }
}

// ── POST /search ─────────────────────────────────────────────────────────────
export async function handleAgentSearch(request, env) {
  const denied = guard(request, env)
  if (denied) return denied

  let body
  try { body = await request.json() } catch { return jsonResponse({ error: "Bad JSON" }, 400) }
  const query = (body.query || "").trim()
  if (!query) return jsonResponse({ results: [] })
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 10)

  try {
    const siteUrl = env.SITE_URL || "https://your-project.pages.dev"
    const notes = await retrieveRelevantNotes(query, [], siteUrl, env)
    const seen = new Set()
    const results = []
    for (const n of notes) {
      if (seen.has(n.slug)) continue
      seen.add(n.slug)
      results.push({
        slug: n.slug,
        title: n.title,
        url: `${siteUrl}/${n.slug}`,
        excerpt: (n.content || "").slice(0, 300),
      })
      if (results.length >= limit) break
    }
    return jsonResponse({ results })
  } catch (err) {
    console.error("handleAgentSearch error:", err)
    return jsonResponse({ error: "Search failed", detail: String(err?.message || err) }, 500)
  }
}

// ── POST /ask ────────────────────────────────────────────────────────────────
export async function handleAgentAsk(request, env) {
  const denied = guard(request, env)
  if (denied) return denied

  let body
  try { body = await request.json() } catch { return jsonResponse({ error: "Bad JSON" }, 400) }
  const question = (body.question || "").trim()
  if (!question) return jsonResponse({ error: "Missing question" }, 400)
  const history = Array.isArray(body.history) ? body.history.slice(-6) : []

  try {
    const siteUrl = env.SITE_URL || "https://your-project.pages.dev"
    const recentCtx = history.map(h => h.content || "").join(" ")
    const [expanded] = await Promise.all([expandQueryBilingually(question, env)])
    const expandedQuery = `${expanded} ${recentCtx}`.slice(0, 2000)

    const notes = await retrieveRelevantNotes(expandedQuery, history, siteUrl, env)
    const noteContext = notes.length
      ? notes.map((n, i) => `[Note ${i + 1}] "${n.title}"\n${n.content.slice(0, 1200)}`).join("\n\n---\n\n")
      : null

    const isHebrew = /[֐-׿]/.test(question)
    const systemPrompt = [
      `You are the user's personal second brain assistant.`,
      `The brain site is at: ${siteUrl}`,
      `Today's date: ${new Date().toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}`,
      isHebrew
        ? `IMPORTANT: The user asked in Hebrew — respond entirely in Hebrew.`
        : `Respond in the same language the user used. Be concise and direct.`,
      noteContext
        ? `\nUse the following saved notes to answer (cite with [Note N]):\n\nNOTES:\n${noteContext}`
        : `\nNo relevant notes were found. Do NOT invent facts about specific people, products, or companies — say no saved notes were found on this topic.`,
    ].join("\n")

    const isComplex = question.length > 120 || notes.length > 2 || history.length > 4
      || /נתח|השווה|סכם|כתוב|תסביר|analyze|compare|summarize|write|explain/i.test(question)
    const model = isComplex
      ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      : "@cf/meta/llama-3.1-8b-instruct"
    const r = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: "user", content: question },
      ],
      max_tokens: isComplex ? 700 : 400,
    })
    const answer = r.response?.trim() || "⚠️ No answer produced."

    const sources = notes.slice(0, 3).map(n => ({
      slug: n.slug,
      title: n.title,
      url: `${siteUrl}/${n.slug}`,
    }))
    return jsonResponse({ answer, sources })
  } catch (err) {
    console.error("handleAgentAsk error:", err)
    return jsonResponse({ error: "Ask failed", detail: String(err?.message || err) }, 500)
  }
}

// ── POST /recent ─────────────────────────────────────────────────────────────
export async function handleAgentRecent(request, env) {
  const denied = guard(request, env)
  if (denied) return denied

  let body = {}
  try { body = await request.json() } catch { /* body optional */ }
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 20)

  try {
    const siteUrl = env.SITE_URL || "https://your-project.pages.dev"
    const branch = env.GITHUB_BRANCH || "main"
    const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "OrBrainBot" }

    // List content/inbox from GitHub (the public site is passphrase-gated, so a
    // server-side fetch of contentIndex.json would 401 — read the repo instead).
    const listRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/contents/content/inbox?ref=${branch}`,
      { headers: ghHeaders },
    )
    if (!listRes.ok) return jsonResponse({ results: [] })
    const files = (await listRes.json())
      .filter(f => f.type === "file" && f.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name)) // timestamp-prefixed → newest first
      .slice(0, limit)

    const results = await Promise.all(files.map(async f => {
      const slug = `inbox/${f.name.replace(/\.md$/, "")}`
      let title = f.name
      let date = ""
      try {
        const raw = decodeGithubContent((await (await fetch(f.url, { headers: ghHeaders })).json()).content)
        const fm = parseFrontmatterForReport(raw, f.name)
        if (fm) { title = fm.title; date = fm.date }
      } catch { /* keep filename */ }
      return { slug, title, date, url: `${siteUrl}/${slug}` }
    }))

    return jsonResponse({ results })
  } catch (err) {
    console.error("handleAgentRecent error:", err)
    return jsonResponse({ error: "Recent failed", detail: String(err?.message || err) }, 500)
  }
}

// ── POST /delete ─────────────────────────────────────────────────────────────
export async function handleAgentDelete(request, env) {
  const denied = guard(request, env)
  if (denied) return denied

  let body
  try { body = await request.json() } catch { return jsonResponse({ error: "Bad JSON" }, 400) }
  const slug = (body.slug || "").trim().replace(/^\/+/, "")
  if (!slug) return jsonResponse({ error: "Missing slug" }, 400)

  try {
    const { deleted, mainFound } = await deleteNote(slug, env)
    return jsonResponse({ ok: mainFound, deleted, slug: escapeHtmlTg(slug) })
  } catch (err) {
    console.error("handleAgentDelete error:", err)
    return jsonResponse({ error: "Delete failed", detail: String(err?.message || err) }, 500)
  }
}
