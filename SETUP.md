# Second Brain — Setup Guide

A personal knowledge wiki with an AI capture pipeline:

- **Wiki** — [Quartz v4](https://quartz.jzhao.xyz) renders `content/` (Markdown, Obsidian-flavored) into a static site.
- **Capture** — a Telegram bot (Cloudflare Worker) receives text/links/photos/voice/video, tags them with AI, and commits them to `content/inbox/`.
- **Promote** — a GitHub Action synthesizes new inbox captures into the wiki layer (`content/notes`, `meetings`, `decisions`, `projects`) using Gemini.
- **Search** — notes get chunked and embedded into Cloudflare Vectorize for semantic search, backed by Supabase for chunk metadata.
- **brain MCP server** — exposes the wiki to [Claude Code](https://claude.com/claude-code) as local tools (`search_notes`, `read_note`, `list_catalog`, `recent_activity`) so an LLM can read (and help maintain) your wiki directly from your terminal.

The system's content contract — how pages are structured, tagged, and cross-linked — lives in [`CLAUDE.md`](./CLAUDE.md). Read it before writing your first note; it's the spec an LLM (or you) follows when filing things into the wiki.

This guide gets you from a fresh clone to a working, deployed instance of all of the above, under your own accounts. Expect ~45–60 minutes end to end, plus a few minutes waiting on DNS/propagation.

---

## 0. Prerequisites

- **Node.js 22+** and npm — check with `node -v`
- **git** and a **GitHub account**
- A **Cloudflare account** (free tier is enough) — hosts the site (Pages), the bot (Workers), and semantic search (Vectorize + AI binding)
- A **Telegram account** — to create your capture bot via [@BotFather](https://t.me/BotFather)
- A **Gemini API key** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) (free tier: 1500 req/day, used for tagging + promote + lint)
- A **Supabase account** (free tier) — [supabase.com](https://supabase.com), used for chunk metadata storage
- **[Claude Code](https://claude.com/claude-code)** installed locally, if you want the `brain` MCP server (optional but the main point of this whole thing)

---

## 1. Clone and install

```bash
git clone <this-template-repo-url> my-second-brain
cd my-second-brain
npm install
```

Create your own GitHub repo (don't push to the template's repo) and point `origin` at it:

```bash
git remote set-url origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```

---

## 2. Cloudflare Pages — hosting the wiki

1. `npx wrangler login` — authenticates the CLI with your Cloudflare account.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick your new repo, branch `main`.
   - Build command: `npm run build:brain`
   - Output directory: `public`
3. Deploy once manually to confirm it builds, or just let the `deploy-pages.yml` GitHub Action (set up in step 5) handle it on push.
4. Note the resulting URL — something like `your-project.pages.dev`.
5. Update `quartz.config.ts` → `baseUrl` with that URL, and `.github/workflows/deploy-pages.yml` → `--project-name=` with your Pages project's actual name.

### Locking it down with a passphrase

The site ships with a passphrase gate (`functions/_middleware.js`), reading `env.SITE_PASSPHRASE`. Set it in the Pages project's **Settings → Environment variables**:

```
SITE_PASSPHRASE = <pick something only you know>
```

---

## 3. Cloudflare Worker — the Telegram capture bot

1. Create a KV namespace for bot state:
   ```bash
   npx wrangler kv namespace create BRAIN_KV
   ```
   Copy the returned `id` into `worker/wrangler.toml` under `[[kv_namespaces]]`.
2. Pick a Worker name and set it in `worker/wrangler.toml` (`name = "..."`).
3. Update the `[vars]` block in `worker/wrangler.toml`:
   - `GITHUB_REPO` → `<your-username>/<your-repo-name>`
   - `GITHUB_BRANCH` → `main`
   - `SITE_URL` → your Pages URL from step 2
4. Also update the `workerUrl` fallback in `quartz.layout.ts` (two occurrences) and `functions/api/webhook.js` / `quartz/static/chat.js` to your eventual Worker URL — you'll know the exact URL after first deploy (`<worker-name>.<your-cf-subdomain>.workers.dev`); it's fine to deploy once, note the URL, then fix these and redeploy.
5. Set Worker secrets (never commit these — `wrangler secret put` stores them in Cloudflare, not in the repo):
   ```bash
   cd worker
   npx wrangler secret put TELEGRAM_BOT_TOKEN     # from BotFather, step 4 below
   npx wrangler secret put WEBHOOK_SECRET          # any random string you invent
   npx wrangler secret put GITHUB_TOKEN            # a GitHub PAT with repo write access
   npx wrangler secret put ALLOWED_CHAT_IDS        # your Telegram numeric chat id(s), comma-separated
   npx wrangler secret put CHAT_PASSPHRASE         # passphrase for the web chat endpoint (can match SITE_PASSPHRASE)
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put SUPABASE_URL            # from step 6
   npx wrangler secret put SUPABASE_SERVICE_KEY    # from step 6, service_role key — server-side only
   ```
6. Deploy: `npx wrangler deploy` (from `worker/`), or push to `main` once the GitHub Action secrets (step 5 below) are set.

---

## 4. Telegram bot — creating it

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts → copy the **bot token**.
2. Find your own numeric Telegram chat id (message [@userinfobot](https://t.me/userinfobot), or check the Worker logs on first message) → this is `ALLOWED_CHAT_IDS`.
3. Set the webhook so Telegram sends updates to your Worker:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker-url>/telegram&secret_token=<WEBHOOK_SECRET>"
   ```
4. Send your bot a test message — it should reply and a new file should appear under `content/inbox/` in your GitHub repo within a minute or two.

---

## 5. Supabase — chunk metadata + keepalive

1. Create a new project at [supabase.com](https://supabase.com) (any region).
2. Project Settings → API → copy the **Project URL** and the **service_role key** (not the anon key — this is server-side only, never expose it client-side).
3. These are the `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` values used above (Worker secrets) and below (GitHub Actions secrets).
4. Free-tier Supabase projects pause after ~7 days of inactivity. The `keepalive.yml` workflow pings it every 3 days automatically — no action needed once secrets are set.

---

## 6. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add all of these (same values used above):

| Secret | Used by |
|---|---|
| `GEMINI_API_KEY` | promote, lint, backfill |
| `TELEGRAM_BOT_TOKEN` | promote, backfill |
| `TELEGRAM_OWNER_CHAT_ID` | promote, backfill (for error notifications) |
| `SUPABASE_URL` | embed, keepalive, promote, backfill |
| `SUPABASE_SERVICE_KEY` | embed, keepalive, promote, backfill |
| `CF_ACCOUNT_ID` | deploy-pages, deploy-worker, embed, promote, backfill |
| `CF_API_TOKEN` | deploy-pages, deploy-worker, embed, promote, backfill |

`CF_ACCOUNT_ID` and `CF_API_TOKEN`: Cloudflare dashboard → right sidebar has your Account ID; create an API token under **My Profile → API Tokens** with Pages/Workers/Vectorize edit permissions.

Once these are set, pushing to `main` triggers `deploy-pages.yml` and `deploy-worker.yml` automatically, and pushes touching `content/inbox/**` or `content/**/*.md` trigger `promote.yml` / `embed.yml`.

---

## 7. The `brain` MCP server — wiring your wiki into Claude Code

```bash
cd mcp-server
npm install
```

Register it with Claude Code (user scope = available in every project):

```bash
claude mcp add brain --scope user -- node /absolute/path/to/your-repo/mcp-server/index.mjs
```

This gives Claude Code four local, no-config tools that read straight off disk: `search_notes`, `read_note`, `list_catalog`, `recent_activity`. No rebuild needed to see new captures.

To also enable `remote_semantic_search` (meaning-based search via the deployed `/api/search`, once embeddings exist):

```bash
claude mcp add brain --scope user \
  --env BRAIN_PASSPHRASE=<your-own-SITE_PASSPHRASE-value> \
  -- node /absolute/path/to/your-repo/mcp-server/index.mjs
```

**Use your own path and your own passphrase** — don't copy these from anyone else's setup; the MCP entry hardcodes an absolute path and your passphrase is a personal secret.

Then, in your own global `CLAUDE.md` (`~/.claude/CLAUDE.md`), add a short section telling Claude Code to check this wiki proactively — e.g. "before responding, check the brain MCP via `search_notes`/`list_catalog`" — pointing at your own vault path.

---

## 8. Writing your first notes

Read [`CLAUDE.md`](./CLAUDE.md) in this repo fully — it's the contract for how content is organized:

- **Raw layer** (`content/inbox/`) — immutable bot captures, never hand-edited.
- **Wiki layer** (`content/notes`, `meetings`, `decisions`, `projects`, `journal`) — synthesized pages, one concept per page, cross-linked via `[[wikilinks]]`.
- **Tag taxonomy** — type tags (`note`, `meeting`, `decision`, ...), domain tags (`ai`, `product`, ...), entity tags (`person/{slug}`, `company/{slug}`, `tool/{slug}`).
- **`catalog.md`** and **`log.md`** are auto-maintained indexes — don't hand-edit them once the promote pipeline is running.

You can write directly in `content/` (e.g. via Obsidian — the repo ships `.obsidian/` config and `content/templates/`), or just send things to your Telegram bot and let `promote.yml` synthesize them.

---

## 9. Verification checklist

- [ ] `npm run build:brain` succeeds locally
- [ ] Cloudflare Pages deployment loads at your `.pages.dev` URL and asks for the passphrase
- [ ] Telegram bot replies to a test message, and the message appears in `content/inbox/` on GitHub within ~1 minute
- [ ] `promote.yml` runs after that push and produces a new page under `content/notes/` (or updates an existing one) + a `log.md` entry
- [ ] `claude mcp list` shows `brain`, and `search_notes` / `list_catalog` return results from Claude Code
- [ ] (Optional) `embed.yml` runs cleanly and `remote_semantic_search` returns results once you have a few notes

---

## What's next

Once this is running smoothly for a week or two of real daily use, you can layer on: a custom homepage dashboard (`content/index.md` ships as a plain placeholder here — build your own stats widget once you have real data), a weekly digest, or additional chat modes on top of `functions/api/chat.js`. Don't rush into extras before the core loop (capture → promote → read) is a real habit.
