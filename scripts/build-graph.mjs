#!/usr/bin/env node
/**
 * Build knowledge graph from Obsidian wikilinks.
 * Outputs quartz/static/kg/graph.json with nodes + edges.
 * Quartz copies quartz/static/ into public/ during build,
 * so graph.json survives the CF Pages build step.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { globby } from 'globby'
import matter from 'gray-matter'
import path from 'path'

const CONTENT_DIR = 'content'
const OUTPUT_DIR = 'quartz/static/kg'
const OUTPUT_FILE = `${OUTPUT_DIR}/graph.json`
const IGNORED = ['.obsidian', 'templates', 'attachments', 'private']
// Auto-maintained hub pages — their links-to-everything edges are navigation,
// not knowledge, and they poison both the graph view and RAG 1-hop expansion.
const META_PAGES = new Set(['catalog', 'log', 'activity', 'overview'])

// Matches [[target]], [[target#heading]], [[target|alias]], [[target#heading|alias]]
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g

function noteId(filePath) {
  return filePath.replace(/^content\//, '').replace(/\.md$/, '')
}

function noteType(id) {
  const parts = id.split('/')
  return parts.length > 1 ? parts[0] : 'root'
}

function extractLinks(content) {
  const links = new Set()
  let m
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    links.add(m[1].trim())
  }
  return [...links]
}

// Resolve a wikilink string to a canonical node id using Obsidian's shortest-path rule
function resolveTarget(target, allIds) {
  const slug = target.toLowerCase().replace(/\s+/g, '-').replace(/[^\w/-]/g, '')
  if (allIds.has(slug)) return slug
  for (const id of allIds) {
    if (id === slug || id.endsWith('/' + slug)) return id
  }
  return null
}

async function main() {
  const files = await globby(`${CONTENT_DIR}/**/*.md`, {
    ignore: IGNORED.map(d => `${CONTENT_DIR}/${d}/**`),
  })

  const nodes = []
  const rawEdges = []

  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const { data: fm, content } = matter(raw)
    if (fm.draft) continue

    const id = noteId(file)
    if (META_PAGES.has(id)) continue
    nodes.push({
      id,
      title: fm.title || path.basename(file, '.md'),
      type: noteType(id),
      tags: fm.tags || [],
      created: fm.date || fm.created || null,
      modified: fm.modified || null,
    })

    rawEdges.push({ source: id, targets: extractLinks(content) })
  }

  const allIds = new Set(nodes.map(n => n.id))

  const edges = []
  for (const { source, targets } of rawEdges) {
    for (const target of targets) {
      const resolved = resolveTarget(target, allIds)
      if (resolved && resolved !== source) {
        edges.push({ source, target: resolved, relation: 'LINKS_TO' })
      }
    }
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(
    OUTPUT_FILE,
    JSON.stringify({ generated: new Date().toISOString(), nodes, edges }, null, 2),
  )

  console.log(`✓ graph.json — ${nodes.length} nodes, ${edges.length} edges → ${OUTPUT_FILE}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
