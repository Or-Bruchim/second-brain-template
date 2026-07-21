#!/usr/bin/env node
/**
 * Periodic wiki health check.
 *
 * Audits content/notes, projects, meetings, decisions, journal for:
 *   - broken wikilinks (target file does not exist)
 *   - orphan pages (no inbound wikilinks)
 *   - catalog drift (page exists but missing from catalog.md, or vice versa)
 *   - stale claims, contradictions, missing concept pages (LLM judgment)
 *
 * Files the report at content/lint/YYYY-MM-DD.md and appends to content/log.md.
 *
 * Triggered weekly by .github/workflows/lint.yml.
 *
 * Required env:
 *   GEMINI_API_KEY      Google AI Studio key
 * Optional env:
 *   GEMINI_MODEL        Defaults to "gemini-2.5-pro"
 *   DRY_RUN             "1" to skip writes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { globby } from 'globby'
import matter from 'gray-matter'
import path from 'path'

// 2.5-pro has a free-tier limit of 0, so it 429s immediately on the free key —
// default to flash (free) and fall back like promote.mjs does.
const { GEMINI_API_KEY, GEMINI_MODEL = 'gemini-2.5-flash', DRY_RUN } = process.env
const GEMINI_FALLBACK_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash']
if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY')
  process.exit(1)
}

const ROOT = process.cwd()
const CONTENT = path.join(ROOT, 'content')
const LINT_DIR = path.join(CONTENT, 'lint')
const CATALOG = path.join(CONTENT, 'catalog.md')
const LOG = path.join(CONTENT, 'log.md')

const WIKI_GLOBS = ['notes/**/*.md', 'projects/**/*.md', 'meetings/**/*.md', 'decisions/**/*.md', 'journal/**/*.md']
const MAX_PAGES_TO_LLM = 60
const MAX_BODY_CHARS = 1500

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g

// ── Static checks (no LLM) ───────────────────────────────────────────────
function staticChecks(pages) {
  const slugSet = new Set(pages.map(p => p.slug))
  const inbound = new Map(pages.map(p => [p.slug, 0]))
  const outbound = new Map(pages.map(p => [p.slug, 0]))
  const broken = []
  for (const p of pages) {
    const targets = [...p.body.matchAll(WIKILINK_RE)].map(m => m[1].trim())
    for (const t of targets) {
      if (slugSet.has(t)) {
        inbound.set(t, (inbound.get(t) || 0) + 1)
        outbound.set(p.slug, (outbound.get(p.slug) || 0) + 1)
      } else if (!t.startsWith('inbox/')) broken.push({ from: p.slug, target: t })
    }
  }
  const orphans = pages.filter(p => (inbound.get(p.slug) || 0) === 0).map(p => p.slug)
  // Connectivity trend metrics (wiki-layer only) — tracked over time in the log.
  const totalEdges = [...outbound.values()].reduce((a, b) => a + b, 0)
  const topHub = [...inbound.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0]
  const connectivity = {
    pages: pages.length,
    linksPerPage: pages.length ? +(totalEdges / pages.length).toFixed(2) : 0,
    orphanPct: pages.length ? +((orphans.length / pages.length) * 100).toFixed(1) : 0,
    underlinked: pages.filter(p => (outbound.get(p.slug) || 0) < 3).map(p => p.slug),
    topHub: { slug: topHub[0], inbound: topHub[1], share: totalEdges ? +((topHub[1] / totalEdges) * 100).toFixed(1) : 0 },
  }
  return { broken, orphans, connectivity }
}

// ── Catalog drift ────────────────────────────────────────────────────────
function catalogDrift(pages) {
  if (!existsSync(CATALOG)) return { extra: [], missing: pages.map(p => p.slug) }
  const cat = readFileSync(CATALOG, 'utf8')
  const cited = new Set([...cat.matchAll(WIKILINK_RE)].map(m => m[1].trim()))
  const slugs = new Set(pages.map(p => p.slug))
  const missing = [...slugs].filter(s => !cited.has(s))
  const extra = [...cited].filter(s => !slugs.has(s) && !s.startsWith('inbox/'))
  return { missing, extra }
}

// ── Build LLM prompt ─────────────────────────────────────────────────────
function buildPrompt(pages, staticFindings) {
  const sample = pages.slice(0, MAX_PAGES_TO_LLM).map(p => {
    return `### ${p.slug}\nTitle: ${p.title}\nTags: ${(p.tags || []).join(', ')}\nUpdated: ${p.updated || 'n/a'}\nBody (truncated): ${p.body.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS)}`
  }).join('\n\n')

  return `You are auditing the wiki layer of Second Brain. Read CLAUDE.md for the schema (raw vs wiki layer, page conventions, hard rules).

Run a health check. Find issues that the static checker can't catch. Focus on:
1. **Contradictions** — pages whose claims conflict with each other.
2. **Stale claims** — pages whose information has been superseded by newer pages or by recent context.
3. **Missing concept pages** — concepts/entities mentioned across 3+ pages that don't have their own page yet.
4. **Thin pages** — pages that should be merged into a richer one, or expanded.
5. **Tag inconsistencies** — same concept tagged differently across pages.

Be specific. Cite page slugs. Don't invent issues — return an empty list for any category with no findings.

WIKI PAGES (${pages.length} total, sampling first ${Math.min(MAX_PAGES_TO_LLM, pages.length)}):

${sample || '(empty wiki — no pages to audit)'}

STATIC CHECKER ALREADY FOUND (do not duplicate):
- ${staticFindings.broken.length} broken wikilinks
- ${staticFindings.orphans.length} orphan pages

Return JSON matching the schema.`
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pages: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
        required: ['pages', 'description'],
      },
    },
    stale: {
      type: 'array',
      items: {
        type: 'object',
        properties: { page: { type: 'string' }, reason: { type: 'string' } },
        required: ['page', 'reason'],
      },
    },
    missing_concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { concept: { type: 'string' }, mentioned_in: { type: 'array', items: { type: 'string' } } },
        required: ['concept', 'mentioned_in'],
      },
    },
    thin_pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { page: { type: 'string' }, suggestion: { type: 'string' } },
        required: ['page', 'suggestion'],
      },
    },
    tag_issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, affected: { type: 'array', items: { type: 'string' } } },
        required: ['description', 'affected'],
      },
    },
  },
  required: ['summary', 'contradictions', 'stale', 'missing_concepts', 'thin_pages', 'tag_issues'],
}

async function callGeminiModel(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
    }),
  })
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 500)}`)
  const json = await r.json()
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini empty response')
  return JSON.parse(text)
}

// Try the primary model, then fall back on quota/rate-limit errors.
async function callGemini(prompt) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter(m => m !== GEMINI_MODEL)]
  let lastErr
  for (const model of models) {
    try {
      const result = await callGeminiModel(prompt, model)
      if (model !== GEMINI_MODEL) console.log(`  succeeded with fallback model: ${model}`)
      return result
    } catch (err) {
      if (err.message.includes('429') || err.message.toLowerCase().includes('quota')) {
        console.warn(`  quota exceeded for ${model}, trying next...`)
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr
}

// ── Render report ────────────────────────────────────────────────────────
function renderReport({ findings, staticFindings, drift, today, pageCount }) {
  let md = `---\ntitle: "Lint report — ${today}"\ndate: ${today}\ntags: ["meta", "lint"]\nsource: "lint"\n---\n\n`
  md += `**Pages audited:** ${pageCount}\n\n`
  md += `**Summary:** ${findings.summary}\n\n`

  const c = staticFindings.connectivity
  if (c) {
    md += `## Connectivity\n`
    md += `- Links per page: **${c.linksPerPage}** | Orphan pages: **${c.orphanPct}%** | Top hub: ${c.topHub.slug ? `[[${c.topHub.slug}]] (${c.topHub.share}% of edges)` : '_none_'}\n`
    md += `- Under-linked pages (<3 outbound, ${c.underlinked.length}): ${c.underlinked.length === 0 ? '_none_' : c.underlinked.map(s => `[[${s}]]`).join(', ')}\n\n`
  }

  md += `## Static checks\n`
  md += `\n### Broken wikilinks (${staticFindings.broken.length})\n`
  if (staticFindings.broken.length === 0) md += '_none_\n'
  else for (const b of staticFindings.broken) md += `- \`${b.from}\` → \`${b.target}\` (target does not exist)\n`

  md += `\n### Orphan pages (${staticFindings.orphans.length})\n`
  if (staticFindings.orphans.length === 0) md += '_none_\n'
  else for (const o of staticFindings.orphans) md += `- [[${o}]]\n`

  md += `\n### Catalog drift\n`
  md += `- Pages missing from catalog (${drift.missing.length}): ${drift.missing.length === 0 ? '_none_' : drift.missing.map(s => `[[${s}]]`).join(', ')}\n`
  md += `- Catalog entries pointing to missing pages (${drift.extra.length}): ${drift.extra.length === 0 ? '_none_' : drift.extra.map(s => `\`${s}\``).join(', ')}\n`

  md += `\n## Semantic audit\n`

  md += `\n### Contradictions (${findings.contradictions.length})\n`
  if (findings.contradictions.length === 0) md += '_none_\n'
  else for (const c of findings.contradictions) md += `- ${c.pages.map(p => `[[${p}]]`).join(' vs ')} — ${c.description}\n`

  md += `\n### Stale claims (${findings.stale.length})\n`
  if (findings.stale.length === 0) md += '_none_\n'
  else for (const s of findings.stale) md += `- [[${s.page}]] — ${s.reason}\n`

  md += `\n### Missing concept pages (${findings.missing_concepts.length})\n`
  if (findings.missing_concepts.length === 0) md += '_none_\n'
  else for (const m of findings.missing_concepts) md += `- **${m.concept}** — mentioned in: ${m.mentioned_in.map(p => `[[${p}]]`).join(', ')}\n`

  md += `\n### Thin pages (${findings.thin_pages.length})\n`
  if (findings.thin_pages.length === 0) md += '_none_\n'
  else for (const t of findings.thin_pages) md += `- [[${t.page}]] — ${t.suggestion}\n`

  md += `\n### Tag inconsistencies (${findings.tag_issues.length})\n`
  if (findings.tag_issues.length === 0) md += '_none_\n'
  else for (const t of findings.tag_issues) md += `- ${t.description} — affected: ${t.affected.map(p => `[[${p}]]`).join(', ')}\n`

  return md
}

function appendLog(today, summary, totalIssues, connectivity) {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const conn = connectivity ? ` | links/page ${connectivity.linksPerPage}, orphans ${connectivity.orphanPct}%` : ''
  const entry = `\n## [${ts}] lint | ${summary} (${totalIssues} issue${totalIssues === 1 ? '' : 's'} flagged)${conn}\n- report: [[lint/${today}]]\n`
  let existing = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '---\ntitle: Log\ntags: ["meta"]\n---\n'
  writeFileSync(LOG, existing + entry)
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const files = await globby(WIKI_GLOBS, { cwd: CONTENT })
  const pages = files.map(rel => {
    const text = readFileSync(path.join(CONTENT, rel), 'utf8')
    const { data, content } = matter(text)
    return {
      slug: rel.replace(/\.md$/, ''),
      title: data.title || path.basename(rel, '.md'),
      tags: data.tags || [],
      updated: data.updated || data.date || null,
      body: content,
    }
  })

  console.log(`Auditing ${pages.length} wiki pages...`)
  const staticFindings = staticChecks(pages)
  const drift = catalogDrift(pages)
  console.log(`  static: ${staticFindings.broken.length} broken, ${staticFindings.orphans.length} orphans, ${drift.missing.length} catalog-missing, ${drift.extra.length} catalog-extra`)

  let llmFindings
  if (pages.length === 0) {
    llmFindings = { summary: 'Wiki layer is empty — nothing to audit.', contradictions: [], stale: [], missing_concepts: [], thin_pages: [], tag_issues: [] }
  } else {
    llmFindings = await callGemini(buildPrompt(pages, staticFindings))
  }

  const totalIssues =
    staticFindings.broken.length +
    staticFindings.orphans.length +
    drift.missing.length +
    drift.extra.length +
    llmFindings.contradictions.length +
    llmFindings.stale.length +
    llmFindings.missing_concepts.length +
    llmFindings.thin_pages.length +
    llmFindings.tag_issues.length

  console.log(`  llm: ${llmFindings.contradictions.length} contradictions, ${llmFindings.stale.length} stale, ${llmFindings.missing_concepts.length} missing-concepts, ${llmFindings.thin_pages.length} thin, ${llmFindings.tag_issues.length} tag-issues`)
  console.log(`Total issues: ${totalIssues}`)

  const today = new Date().toISOString().slice(0, 10)
  const report = renderReport({ findings: llmFindings, staticFindings, drift, today, pageCount: pages.length })

  if (DRY_RUN === '1') {
    console.log('\n--- DRY RUN — report not written ---\n')
    console.log(report)
    return
  }

  if (!existsSync(LINT_DIR)) mkdirSync(LINT_DIR, { recursive: true })
  writeFileSync(path.join(LINT_DIR, `${today}.md`), report)
  appendLog(today, llmFindings.summary, totalIssues, staticFindings.connectivity)
  console.log(`\nWrote content/lint/${today}.md`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
