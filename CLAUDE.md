# CLAUDE.md — Second Brain wiki schema

You are operating on a personal knowledge wiki. This document is the contract between you and the wiki: how pages are organized, how they look, and what to do when sources arrive, when questions are asked, and when the wiki needs maintenance.

This file follows the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Read it fully before making any edit to `content/`.

## The two layers

The wiki has two layers and they must not be mixed:

**Raw layer — `content/inbox/`.** Immutable captures from the Telegram bot. Files here are the source of truth for what was *captured*. Never edit, rename, or delete them. They look like `2026-04-30-1779000000000.md` and have `source: telegram` (or `chat`, `manual`) in frontmatter.

**Wiki layer — `content/notes/`, `meetings/`, `decisions/`, `projects/`, `journal/`.** LLM-maintained synthesis. Entity pages, concept pages, project pages, meeting notes, decision records, daily journals. You own these files. They cite raw sources via wikilinks (`[[inbox/2026-04-30-1779000000000]]`).

**Index — `content/catalog.md`.** Content-oriented catalog. One-line summary per wiki page, organized by folder. You maintain it; humans read it to navigate. Distinct from the homepage `index.md` (which is a public landing page, not for you to edit).

**Hubs — `content/notes/moc-*.md` (Maps of Content).** Curated hub pages, one per major theme (e.g. `moc-ai-engineering`, `moc-design`, `moc-product`). Each is a short intro plus annotated wikilinks to the notes in that theme, grouped into sections. They are the connectivity backbone of the graph — unlike `catalog.md` (a flat auto-generated inventory), MOCs carry meaning and curation. When you promote a note, add it to the most relevant MOC. Keep them to ~6–10 themes; don't fragment into dozens of tiny MOCs.

**Log — `content/log.md`.** Append-only chronological log of what happened. One entry per ingest, lint pass, or significant promotion. Format below.

## Folder roles

| Folder | What lives here | Who writes |
|---|---|---|
| `inbox/` | Raw Telegram/chat captures. Single-source dumps. | Bot only — never edit |
| `notes/` | Entity/concept pages. One concept per page. The synthesized wiki. | You (LLM) |
| `journal/` | Daily journals (`YYYY-MM-DD.md`). One per day. | Human + LLM |
| `meetings/` | Meeting notes. One per meeting. | Human + LLM |
| `decisions/` | Decision records (ADR-style). One per decision. | Human + LLM |
| `projects/` | Project hubs. One per active project. | Human + LLM |
| `templates/` | Page templates. Don't touch unless asked. | Human |
| `attachments/` | Images, PDFs, files referenced from notes. | Bot + human |
| `lint/` | Periodic lint reports (`YYYY-MM-DD.md`). | LLM (lint job) |

Empty folders today (`notes/`, `meetings/`, `decisions/`, `projects/`) are real — they exist because the wiki layer hasn't been populated yet. Populating them is your job.

## Page conventions

Every wiki-layer page has YAML frontmatter:

```yaml
---
title: "Human-readable title"
date: 2026-04-30          # creation date (YYYY-MM-DD)
updated: 2026-04-30       # last meaningful update — bump on substantive edits
tags: ["entity", "concept", "tool", ...]   # see tag taxonomy below
source: "manual" | "promote" | "synthesis" | "lint"
sources: ["inbox/2026-04-30-1779000000000", ...]   # wikilinks to raw sources
---
```

Templates in `content/templates/` define the body shape per page type — match them. `note.md` is the default for entity/concept pages. `meeting.md`, `decision.md`, `project.md`, `journal.md` for those types.

### Tag taxonomy

Use lowercase, dash-separated. Pick the *narrowest* applicable tag.

- **Type tags** (one per page): `note`, `meeting`, `decision`, `project`, `journal`, `synthesis`, `meta`
- **Domain tags** (zero or more): `ai`, `product`, `design`, `engineering`, `personal`, `health`, `reading`, `business`
- **Entity tags** (zero or more): `person/{slug}`, `company/{slug}`, `tool/{slug}`

### Wikilinks

Use Obsidian-style links: `[[notes/typescript]]`, `[[inbox/2026-04-30-...]]`, `[[projects/ai-strategy-showcase]]`. The path is relative to `content/` and excludes `.md`. The graph builder relies on this — broken links don't fail the build but show as orphans.

### Filenames

- `notes/`: `kebab-case.md`. One concept per file. `notes/transformer-architecture.md` not `notes/Transformers.md`.
- `journal/`: `YYYY-MM-DD.md`.
- `meetings/`: `YYYY-MM-DD-{topic-or-attendee}.md`.
- `decisions/`: `YYYY-MM-DD-{slug}.md` or `ADR-{nnn}-{slug}.md`.
- `projects/`: `kebab-case.md` matching the GitHub repo or product name.

## Workflows

### Ingest (the bot does this — you don't)

The Telegram bot saves a single file to `content/inbox/`. Never modify the bot's pipeline from here. Your job starts at *Promote*.

### Promote (your main job — runs on every new inbox file)

When a new inbox file appears (you'll be told via the `scripts/promote.mjs` flow):

1. **Read the raw file.** Extract: what is this *about*? What entities (people, projects, tools, concepts) does it mention? What facts are new?
2. **Decide what wiki pages to touch.** Search `content/notes/` for existing entity/concept pages that match. Decide: update existing? Create new? A typical promote touches 1–5 wiki pages.
3. **For each touched page:**
   - If new: create from `templates/note.md`, populate with the synthesized content, link back to the raw source via `sources:` frontmatter and a `## Sources` section at the bottom.
   - If existing: append/integrate the new info. Bump `updated:`. Keep narrative cohesion — don't just append bullets.
   - Always link back to the raw inbox file.
4. **Cross-link (every page needs 3–5 real links).** Each wiki page you create or update must weave in 3–5 wikilinks to *existing* pages, earned by the surrounding prose — not a bare "Related:" list, and never a `[[Concept]]` link to a page that doesn't exist (that creates a dead node). Add the page to the most relevant `moc-*` hub. If an entity is mentioned 3+ times across the wiki but has no page, suggest creating one (note in `log.md`).
5. **Update `catalog.md`.** New page → add line under the right section. Updated page → if the one-line summary changed, update it.
6. **Append to `log.md`.** One entry per promote run.
7. **Don't touch `inbox/`.** Never edit the raw file. The synthesis lives in the wiki layer; the raw stays raw.

A promote that just files a copy of the raw note in `notes/` is a failure — that's RAG, not a wiki. The point is *synthesis with what was already there*.

### Query (when answering questions about the wiki)

1. Read `catalog.md` first.
2. Drill into 2–5 candidate pages.
3. If raw source is needed, follow `sources:` links into `inbox/`.
4. Answer with citations: `[[notes/transformer-architecture]]`, `[[inbox/2026-04-30-...]]`.
5. **If the answer is a real synthesis** (a comparison, an analysis, a connection across pages), offer to save it as a new page in `notes/synthesis/YYYY-MM-DD-{slug}.md` with `source: synthesis`. Don't let good answers vanish into chat history.

### Lint (weekly, scheduled)

Run when asked or by the cron job. Audit:

- **Contradictions.** Find pages whose claims conflict.
- **Stale claims.** Find pages whose `updated:` is old and whose claims have been superseded by newer inbox sources.
- **Orphan pages.** Pages with no inbound wikilinks.
- **Missing pages.** Concepts mentioned in 3+ places that don't have their own page.
- **Broken wikilinks.** Targets that don't resolve.
- **Catalog drift.** Pages that exist but aren't in `catalog.md`, or catalog entries that don't exist.

File the report at `content/lint/YYYY-MM-DD.md` with `tags: ["meta", "lint"]`. Append a one-line entry to `log.md`.

## `log.md` format

Append-only. Each entry on its own line. Format:

```
## [YYYY-MM-DD HH:MM] {ingest|promote|query|lint|synthesis} | <one-line summary>
```

Optional indented bullets after for detail. Example:

```
## [2026-04-30 14:22] promote | Karpathy "LLM Wiki" gist → notes/llm-wiki-pattern, notes/memex
- created notes/llm-wiki-pattern from inbox/2026-04-30-1779...
- linked to existing notes/rag-patterns
- bumped notes/personal-knowledge-management.updated
```

This format is parseable: `grep '^## \[' content/log.md | tail -20` gives the recent timeline.

## `catalog.md` format

```markdown
---
title: Catalog
tags: ["meta"]
updated: 2026-04-30
---

> Auto-maintained by the promote/lint workflows. Don't edit by hand — it'll be overwritten.

## Notes
- [[notes/transformer-architecture]] — How transformer attention works; the QKV math
- [[notes/rag-patterns]] — Retrieval-augmented generation tradeoffs

## Projects
- [[projects/ai-strategy-showcase]] — Client showcase deck project

## Meetings
- [[meetings/2026-04-15-project-kickoff]] — Project workplan kickoff

## Decisions
- [[decisions/2026-04-20-quartz-over-notion]] — Why we picked Quartz

## Synthesis
- [[notes/synthesis/2026-04-30-rag-vs-wiki]] — Compounding knowledge debate
```

Order sections: Notes, Projects, Meetings, Decisions, Journal (most-recent only), Synthesis, Lint reports. Within sections: alphabetical for entity/concept pages, reverse-chronological for date-anchored pages.

## Hard rules

1. **Never modify `content/inbox/*.md`.** It's immutable.
2. **Never modify `content/templates/*.md`** unless explicitly asked.
3. **Never modify `content/index.md`** (homepage) or `content/activity.md` (dashboard) — they're custom pages with embedded widgets.
4. **Never invent sources.** Every claim in a wiki page traces back to an inbox file or external citation. If you can't cite it, don't claim it.
5. **Hebrew content stays Hebrew.** Don't translate — preserve original language. Brand names stay in Latin script per project convention.
6. **Bidirectional links.** When you link A→B in a wiki page, ensure B has context that justifies the inbound link. Quartz auto-renders backlinks but they should be meaningful.
7. **Frontmatter `updated:` is sacred.** Bump it only on substantive edits. Cosmetic changes (typos, formatting) don't count.
8. **One concept per page.** If a page is becoming two concepts, split it.
9. **No half-done pages.** Either create the page properly or note it in `log.md` as a TODO. Never commit a stub.
10. **Commit message prefix.** Promote runs commit with `promote:`; lint with `lint:`; synthesis with `synth:`. The CI uses these to avoid retrigger loops.

## When in doubt

- Read `catalog.md` to see what already exists.
- Search `content/` with grep before creating a new page.
- If a concept already has a page, extend it. Don't fragment.
- Prefer fewer, denser pages over many thin ones.
- If you're not sure where a piece of info goes, file it as a `TODO` in `log.md` and ask in the next session.

## Stack reference

- Wiki source: `content/` (markdown, Obsidian-flavored)
- Static site: Quartz v4 → Cloudflare Pages
- Capture pipeline: Telegram → `worker/telegram-bot.js` → `content/inbox/`
- Search/RAG: Cloudflare Vectorize index `brain-chunks` (chunks via `scripts/embed.mjs`)
- Graph: `scripts/build-graph.mjs` → `quartz/static/kg/graph.json`
- Promote/lint: `scripts/promote.mjs`, `scripts/lint-wiki.mjs` (run via GitHub Actions)
- Auth: passphrase via Pages middleware (`functions/_middleware.js`)
