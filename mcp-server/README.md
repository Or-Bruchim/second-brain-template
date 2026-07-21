# brain-mcp

MCP server exposing Second Brain (this wiki) to Claude Code.

## Tools

Local (always on, no config, no network):
- `search_notes` — substring search across all markdown in `content/`
- `read_note` — read a page's full raw content by path
- `list_catalog` — the wiki's one-line-per-page index
- `recent_activity` — tail of `content/log.md`

Remote (opt-in, needs the passphrase):
- `remote_semantic_search` — calls the deployed `/api/search` (Cloudflare Vectorize embeddings) for meaning-based search beyond exact keyword match

## Setup

```
cd mcp-server && npm install
```

Register with Claude Code (user scope — available in every project):

```
claude mcp add brain --scope user -- node /absolute/path/to/your-repo/mcp-server/index.mjs
```

To enable the remote tool, set the passphrase as an env var on the MCP entry:

```
claude mcp add brain --scope user \
  --env BRAIN_PASSPHRASE=<your-site-passphrase> \
  -- node /absolute/path/to/your-repo/mcp-server/index.mjs
```

Without `BRAIN_PASSPHRASE`, `remote_semantic_search` returns a clear error; the local tools work regardless.

## Notes

- Local tools always read whatever's on disk in `../content` — no rebuild needed to see new inbox captures or promoted notes.
- The remote tool talks to `https://your-project.pages.dev` by default; override with `BRAIN_API_URL` if the deployment moves.
- This directory is tooling, not wiki content — none of the `CLAUDE.md` wiki hard-rules (immutable inbox, etc.) apply here.
