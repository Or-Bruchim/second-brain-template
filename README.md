# Second Brain

Personal knowledge base and AI assistant — built on [Quartz v4](https://quartz.jzhao.xyz/) (an open-source tool that turns a folder of Markdown notes into a browsable website, originally made for "digital gardens"), hosted on Cloudflare Pages (Cloudflare's website-hosting service, similar to Vercel or Netlify), powered by a Telegram bot and a RAG pipeline (Retrieval-Augmented Generation — instead of the AI answering from memory alone, it first looks up relevant notes and feeds them to the model as context, so answers are grounded in what you actually saved).

## What it does

- **Capture** — Send a link, text, image, or file to a Telegram bot → automatically saved to the vault (the folder of notes) with an AI-generated title, summary, tags, and context
- **Search** — Semantic vector search across all saved notes (search by *meaning*, not just exact keywords — e.g. searching "how do I stay focused" can surface a note about "avoiding distractions" even without a shared word)
- **Chat** — Ask questions about your notes, get answers grounded in your own knowledge base (the RAG pipeline above)
- **Graph** — A knowledge graph built from wikilinks (`[[note-name]]`-style links between notes, borrowed from Obsidian/Roam), with 1-hop context expansion (when you look at one note, its directly-linked neighbors are pulled in too) on every query

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ INPUT                                                                │
│ Telegram (text · photo · voice/audio · document(PDF) · video ·      │
│           URL: YouTube/Instagram/TikTok/X/Facebook/generic)          │
│ Web chat upload (image · video · file attachment)                    │
└──────────────────────────────┬────────────────────────────────────┘
                                ▼
                 Cloudflare Worker  (worker/*.js)
                 │  (a "Worker" is a small serverless function — code that
                 │   runs on-demand in response to a request, with no server
                 │   to manage)
                 ├── telegram.js   — webhook (Telegram calls this URL the
                 │      instant a message arrives — push, not polling),
                 │      sends replies, downloads files
                 ├── intent.js     — routeIntent(): asks an AI model to
                 │      classify what the message is *for*, then picks a
                 │      handler:
                 │      → save | ask | search | journal | recipe |
                 │        reminder | calendar | image-gen | artifact |
                 │        web-search | meta-instruction | converse
                 ├── media.js      — per-kind extraction (turning each
                 │      input type into plain text/summary the AI can use):
                 │      • URL  → oEmbed (a small standard JSON format sites
                 │                like YouTube/Instagram/TikTok/X publish so
                 │                other apps can embed their content) or,
                 │                for sites without it, a generic OpenGraph
                 │                scrape (the `<meta>` tags a page adds so
                 │                links look good when shared — title,
                 │                description, preview image)
                 │      • video → download → Gemini 2.5 Flash (Google's AI
                 │                model, chosen here because it can watch
                 │                video directly) → transcript + summary
                 │      • photo → Gemini vision analysis (the model looks
                 │                at the image and describes it)
                 │      • voice/audio → Workers AI transcription
                 │                (Cloudflare's hosted AI models — speech
                 │                converted to text)
                 │      • PDF  → given to Gemini as a document → text
                 ├── ai.js         — tagging + title/summary synthesis
                 │      (Llama 3.1 8B / 3.3 70B — open-source models from
                 │       Meta, run via Workers AI; Gemini 2.0/2.5 Flash as
                 │       a fallback if those are unavailable)
                 ├── handlers.js   — one handler per intent (24 total):
                 │      save, chat, search, journal, recipe, reminder,
                 │      calendar event, image generation, HTML artifact
                 │      generate/edit, web search, delete, later-queue…
                 ├── github.js     — commitFile(): writes the finished
                 │      note as a real file, committed to this GitHub repo
                 │      → content/inbox/*.md + content/attachments/*
                 └── digest.js     — daily/weekly summary jobs
                                │
                                ▼
                 GitHub (your-username/your-repo-name — the vault's permanent,
                        version-controlled storage)
                 ├── content/inbox/*.md      ← immutable raw captures
                 └── triggers GitHub Actions (GitHub's built-in automation:
                        scripts that run automatically whenever files change)
                        ├── embed.yml       → scripts/embed.mjs
                        │      chunks notes (splits long text into smaller
                        │      pieces) → converts each chunk to a vector
                        │      embedding (a list of numbers capturing its
                        │      meaning) → stores in Vectorize (brain-chunks)
                        │      — Cloudflare's database built for this kind
                        │      of "search by meaning" lookup
                        ├── promote (LLM)   → scripts/promote.mjs
                        │      an AI step that reads each raw capture and
                        │      weaves it into the permanent wiki:
                        │      synthesizes inbox → content/notes/*,
                        │      updates catalog.md + moc-*.md + log.md
                        ├── lint (LLM, weekly) → scripts/lint-wiki.mjs
                        │      an AI health-check for the wiki (finds
                        │      contradictions, stale notes, broken links)
                        │      → content/lint/YYYY-MM-DD.md
                        └── build-graph     → scripts/build-graph.mjs
                               turns the wikilinks into a graph data file
                               → quartz/static/kg/graph.json
                                │
                                ▼
                 Cloudflare Pages  (your-project.pages.dev — the public
                        website these files render into)
                 ├── Static site built from content/ via Quartz
                 ├── /api/chat    → RAG chat: looks up relevant chunks in
                 │      Vectorize, hands them to Gemini 2.5 Pro, and
                 │      streams the answer back word-by-word (SSE — Server-
                 │      Sent Events, the technique behind ChatGPT-style
                 │      typing effects)
                 ├── /api/search  → semantic search endpoint (same
                 │      "search by meaning" idea, exposed as an API)
                 ├── Graph View   → renders graph.json as an interactive
                 │      node-link diagram using cytoscape.js (a JS graph-
                 │      visualization library)
                 └── functions/_middleware.js — the privacy gate: visitors
                        must enter a passphrase; it's checked via an HMAC
                        cookie (a tamper-proof signed cookie — the server
                        can tell if it's been forged), valid 30 days,
                        and auto-recovers if the session quietly expires

                 mcp-server/ (runs locally, talks over stdio — i.e. it's a
                        plain command-line program an app launches and
                        talks to via stdin/stdout, not a network server)
                 └── exposes content/ read tools + remote search to
                     ANY MCP-compatible client (MCP = Model Context
                     Protocol, an open standard for letting AI assistants
                     call external tools) — Claude Code, Claude Desktop,
                     Cursor, VS Code Copilot, etc. — not tied to one IDE.
```

## Stack

| Layer | Tech | What that means |
|-------|------|------|
| Site | Quartz v4 (React + TypeScript) | The static-site generator that turns Markdown notes into web pages |
| Hosting | Cloudflare Pages | Where the website actually lives, like Vercel/Netlify but on Cloudflare |
| Bot | Cloudflare Worker (`worker/telegram.js`) | The serverless backend the Telegram bot runs on |
| Vectors | Cloudflare Vectorize (`brain-chunks`) | The database that stores note embeddings for "search by meaning" |
| Embeddings | `@cf/baai/bge-base-en-v1.5` | The specific AI model that converts text into those searchable number-vectors |
| Chat (Telegram) | Llama 3.3 70B (Workers AI) | Meta's open-source model, hosted by Cloudflare, answering questions inside Telegram |
| Chat (Web) | Gemini 2.5 Pro (streaming SSE) | Google's model, used for the chat on the website, streamed in like a typing effect |
| Storage | GitHub (notes as Markdown) + Cloudflare KV | Notes live as plain files in a Git repo (full history, no lock-in); KV is a small fast key-value store for bits of bot state |
| Auth | HMAC passphrase cookie (30-day session) | A single shared passphrase gates the site; a signed cookie remembers you're logged in for 30 days |

## Supported inputs & how each is processed

| Input | Detected via | Processing |
|---|---|---|
| Plain text | default | An AI model classifies what you're trying to do (`intent.js`), then routes to the matching handler — save a note, start a journal entry, save a recipe, set a reminder, ask a question, or a meta-instruction (an instruction about the wiki itself, like "tag this as marketing") |
| Link — YouTube | URL pattern match | Reads the video's public oEmbed data (title/author, a small standard format YouTube publishes); pulls the transcript from YouTube's own subtitle system; Gemini 2.5 Flash summarizes it |
| Link — Instagram / TikTok / X (Twitter) | URL pattern match | Same oEmbed idea for title/author; the underlying video or image is fetched and handed to Gemini to actually understand the content, not just the caption |
| Link — Facebook / any other URL | fallback (no oEmbed support) | Scrapes the page's OpenGraph tags (the hidden `<meta>` fields a site adds so its links preview nicely when shared) for title/description/image; Gemini summarizes if there's enough real content |
| Photo | Telegram marks the message as a photo | Downloaded, then described by Gemini's vision model before tagging |
| Voice / audio message | Telegram marks it as voice/audio | Downloaded and transcribed to text by Workers AI (Cloudflare's hosted AI models); the transcript is then treated exactly like a typed message |
| Document — PDF | file's MIME type (its declared file type) is `application/pdf` | Sent to Gemini as a document it can read directly → extracted text + summary; shown in the note via Quartz's built-in PDF viewer (`![[file.pdf]]`) |
| Video — sent directly in Telegram, or uploaded in the web chat | Telegram marks it as video, or a file upload | Downloaded, given to Gemini 2.5 Flash (which can watch video natively) for a transcript + summary; if the transcript is long it's saved as its own attached file instead of bloating the note |

Every path converges on the same last step: AI analysis produces a `title`, `summary`, `tags`, a `why_saved` note (why this might matter later), and a `when_to_apply` note (a situation where it'd be useful to recall this) → all committed as one Markdown file in `content/inbox/`.

## Capabilities

Beyond capture, search, and chat, the bot's intent router (`worker/intent.js` → `worker/handlers.js`) supports:

- **Journal** — free-form daily entries (`handleJournalEntry`)
- **Recipes** — save a recipe from text or a photo of a recipe card (`handleRecipeEntry`)
- **Reminders** — set and list one-off/recurring reminders (`handleSetReminder`, `handleListReminders`)
- **Calendar** — create calendar events from a message (`handleCalendarEvent`)
- **Image generation** — generate an image from a text prompt (`handleImageGeneration`)
- **HTML artifacts** — generate or edit a standalone HTML page/slide via Gemini, with a Canva-style visual editor (see `notes/brain-edit-slides`) (`handleGenerateArtifact`, `handleEditArtifact`)
- **Web search** — ad-hoc web lookups from chat (`handleWebSearch`)
- **Later queue** — snooze a message for later triage (`handleLater`, `handleShowQueue`)
- **Delete** — remove a note by slug (`handleDeleteCommand`)

## MCP server — connect from any IDE

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) is an open standard that lets an AI coding assistant call outside tools — think of it as a plug that any AI app can use to reach into this wiki, instead of you having to copy-paste notes into a chat window.

`mcp-server/` is a standard MCP server — a small local program (built with `@modelcontextprotocol/sdk`) that speaks this protocol over stdio (it runs as a plain command-line process; whatever app starts it just talks to it via text in/out, no network port involved). It isn't specific to Claude Code — any MCP-compatible client can register it: Claude Code, Claude Desktop, Cursor, VS Code (Copilot or other MCP-aware extensions), etc.

- **Local tools** (always on, no network needed): `search_notes`, `read_note`, `list_catalog`, `recent_activity` — read straight off disk in `content/`, no rebuild needed
- **Remote tool** (opt-in, needs `BRAIN_PASSPHRASE`): `remote_semantic_search` — calls the deployed `/api/search` endpoint (the same "search by meaning" Vectorize lookup the website uses) instead of a plain text match

Setup for any client: point it at `node /path/to/quartz/mcp-server/index.mjs` as a stdio MCP server. See [mcp-server/README.md](./mcp-server/README.md) for the exact registration command for Claude Code, and adapt the same binary/args for other clients' MCP config.

## Vault structure

```
content/
├── inbox/        ← Telegram captures land here
├── notes/        ← Permanent notes
├── journal/      ← Daily entries
├── meetings/     ← Meeting notes
├── decisions/    ← Decision records
├── projects/     ← Project notes
└── templates/    ← Obsidian templates
```

## How a message gets saved

1. Send link/text/image to Telegram bot
2. Bot reacts with 👀 immediately
3. Classifies intent (save / skip / ask)
4. Enriches URL metadata (YouTube, GitHub, Instagram, generic)
5. Runs AI analysis → title, summary, tags, `why_saved`, `when_to_apply`
6. Commits Markdown note to `content/inbox/`
7. GitHub Action triggers → chunks note → upserts to Vectorize
8. Site redeploys via Cloudflare Pages CI

## Bot commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Query the knowledge base |
| `/delete <slug>` | Delete a note |
| `/reminders` | List active reminders |
| (plain text) | Auto-classifies: save, converse, or skip |

## Setup

See [SETUP.md](./SETUP.md) for full setup instructions including Cloudflare Pages, Obsidian vault, and Worker deployment.

---

*Forked from [jackyzha0/quartz](https://github.com/jackyzha0/quartz)*
