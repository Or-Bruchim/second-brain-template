#!/usr/bin/env node
// Second Brain — MCP server
// Exposes the wiki (content/) to Claude Code as callable tools.
// Local file tools work with zero config. Remote tools (deployed semantic
// search) only activate if BRAIN_PASSPHRASE is set — see README.md.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"

const CONTENT_DIR = path.resolve(
  process.env.BRAIN_CONTENT_DIR || path.join(import.meta.dirname, "..", "content"),
)
const BRAIN_API_URL = process.env.BRAIN_API_URL || "https://your-project.pages.dev"
const BRAIN_PASSPHRASE = process.env.BRAIN_PASSPHRASE || ""

// ---- local file helpers ----------------------------------------------

function resolveSafe(relPath) {
  const full = path.resolve(CONTENT_DIR, relPath)
  if (!full.startsWith(CONTENT_DIR + path.sep) && full !== CONTENT_DIR) {
    throw new Error(`Path escapes content/: ${relPath}`)
  }
  return full
}

async function walkMarkdown(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)))
    else if (entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

function excerptAround(body, query, radius = 100) {
  const idx = body.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return body.slice(0, radius * 2).trim()
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + query.length + radius)
  return (start > 0 ? "…" : "") + body.slice(start, end).trim() + (end < body.length ? "…" : "")
}

// ---- remote auth (lazy, cached for process lifetime) ------------------

let cachedCookie = null

async function getAuthCookie() {
  if (cachedCookie) return cachedCookie
  if (!BRAIN_PASSPHRASE) {
    throw new Error(
      "Remote tools need BRAIN_PASSPHRASE set in the MCP server env (see mcp-server/README.md).",
    )
  }
  const res = await fetch(`${BRAIN_API_URL}/__auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ passphrase: BRAIN_PASSPHRASE }).toString(),
  })
  const setCookie = res.headers.get("set-cookie")
  if (!setCookie || !setCookie.includes("brain_auth=")) {
    throw new Error("Passphrase rejected by brain site — check BRAIN_PASSPHRASE.")
  }
  cachedCookie = setCookie.split(";")[0]
  return cachedCookie
}

async function callBrainApi(endpoint, body) {
  const cookie = await getAuthCookie()
  const res = await fetch(`${BRAIN_API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    cachedCookie = null // cookie expired/invalid — force re-auth next call
    throw new Error("Brain site rejected the auth cookie (expired?). Try again.")
  }
  if (!res.ok) throw new Error(`Brain API ${endpoint} failed: ${res.status} ${await res.text()}`)
  return res
}

// ---- server -------------------------------------------------------------

const server = new McpServer({ name: "brain", version: "1.0.0" })

server.registerTool(
  "search_notes",
  {
    title: "Search Second Brain (local)",
    description:
      "Case-insensitive substring search over the local wiki markdown files (content/notes, journal, meetings, decisions, projects, inbox). Fast, no network. Returns matching pages with an excerpt.",
    inputSchema: {
      query: z.string().describe("Text to search for"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    const files = await walkMarkdown(CONTENT_DIR)
    const hits = []
    for (const file of files) {
      const raw = await fs.readFile(file, "utf8")
      const { data, content } = matter(raw)
      const haystack = `${data.title || ""}\n${content}`
      if (haystack.toLowerCase().includes(query.toLowerCase())) {
        hits.push({
          path: path.relative(CONTENT_DIR, file).replace(/\.md$/, ""),
          title: data.title || path.basename(file, ".md"),
          tags: data.tags || [],
          updated: data.updated || data.date || null,
          excerpt: excerptAround(content, query),
        })
      }
      if (hits.length >= limit) break
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ results: hits }, null, 2) }],
    }
  },
)

server.registerTool(
  "read_note",
  {
    title: "Read a wiki page (local)",
    description:
      "Read the full raw markdown (frontmatter + body) of a wiki page by its path, e.g. 'notes/transformer-architecture' or 'inbox/2026-04-30-1779000000000'. Omit the .md extension.",
    inputSchema: {
      notePath: z.string().describe("Path relative to content/, without .md"),
    },
  },
  async ({ notePath }) => {
    const full = resolveSafe(`${notePath}.md`)
    const raw = await fs.readFile(full, "utf8")
    return { content: [{ type: "text", text: raw }] }
  },
)

server.registerTool(
  "list_catalog",
  {
    title: "List wiki catalog (local)",
    description:
      "Return content/catalog.md — the one-line-per-page index of the whole wiki, organized by section (Notes, Projects, Meetings, Decisions, Synthesis). Read this first when you don't know what exists.",
    inputSchema: {},
  },
  async () => {
    const raw = await fs.readFile(path.join(CONTENT_DIR, "catalog.md"), "utf8")
    return { content: [{ type: "text", text: raw }] }
  },
)

server.registerTool(
  "recent_activity",
  {
    title: "Recent wiki activity (local)",
    description:
      "Tail of content/log.md — the append-only history of ingest/promote/lint/synthesis runs. Use to see what changed recently.",
    inputSchema: {
      lines: z.number().int().min(1).max(200).default(20),
    },
  },
  async ({ lines }) => {
    const raw = await fs.readFile(path.join(CONTENT_DIR, "log.md"), "utf8")
    const entries = raw.split(/\n(?=## \[)/).filter((e) => e.trim())
    return { content: [{ type: "text", text: entries.slice(-lines).join("\n") }] }
  },
)

server.registerTool(
  "remote_semantic_search",
  {
    title: "Semantic search (remote, deployed brain)",
    description:
      "Meaning-based search over the deployed brain's Vectorize embeddings — finds conceptually related notes even without exact keyword overlap. Requires BRAIN_PASSPHRASE configured on this MCP server; fails clearly if not set.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, limit }) => {
    const res = await callBrainApi("/api/search", { query, limit })
    const json = await res.json()
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
