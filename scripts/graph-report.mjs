#!/usr/bin/env node
/**
 * Knowledge-graph connectivity report.
 *
 * Read-only instrument: prints how well the wiki is linked so we can measure
 * the effect of the promote/MOC connectivity work (before vs after).
 *
 * Resolution mirrors scripts/build-graph.mjs exactly (Obsidian shortest-path,
 * META_PAGES excluded) so the numbers match what the graph view actually draws.
 *
 * Usage:
 *   node scripts/graph-report.mjs            # full report to stdout
 *   node scripts/graph-report.mjs --json     # machine-readable summary line
 *
 * No external services or API keys required.
 */
import { readFileSync } from 'fs'
import { globby } from 'globby'
import matter from 'gray-matter'
import path from 'path'

const CONTENT_DIR = 'content'
const IGNORED = ['.obsidian', 'templates', 'attachments', 'private']
// Same hub pages build-graph.mjs drops — their links-to-everything edges are
// navigation, not knowledge.
const META_PAGES = new Set(['catalog', 'log', 'activity', 'overview', 'index'])
// Layers that make up the synthesized wiki (what CLAUDE.md/lint care about).
const WIKI_LAYERS = new Set(['notes', 'projects', 'meetings', 'decisions', 'journal'])

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g

const JSON_OUT = process.argv.includes('--json')

function noteId(filePath) {
  return filePath.replace(/^content\//, '').replace(/\.md$/, '')
}
function layerOf(id) {
  const parts = id.split('/')
  return parts.length > 1 ? parts[0] : 'root'
}
function extractLinks(content) {
  const links = new Set()
  let m
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(content)) !== null) links.add(m[1].trim())
  return [...links]
}
// Obsidian shortest-path resolution, identical to build-graph.mjs
function resolveTarget(target, allIds) {
  const slug = target.toLowerCase().replace(/\s+/g, '-').replace(/[^\w/-]/g, '')
  if (allIds.has(slug)) return slug
  for (const id of allIds) {
    if (id === slug || id.endsWith('/' + slug)) return id
  }
  return null
}
function pct(n, d) {
  return d === 0 ? '0.0' : ((n / d) * 100).toFixed(1)
}
// Embeds of attachment files (images, PDFs) aren't markdown nodes — they're not
// broken knowledge links, so they don't count against connectivity.
function isAttachment(target) {
  return target.startsWith('attachments/') || /\.(png|jpe?g|gif|webp|svg|pdf|mp4|mov|mp3)$/i.test(target)
}

async function main() {
  const files = await globby(`${CONTENT_DIR}/**/*.md`, {
    ignore: IGNORED.map(d => `${CONTENT_DIR}/${d}/**`),
  })

  const nodes = []
  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const { data: fm, content } = matter(raw)
    if (fm.draft) continue
    const id = noteId(file)
    if (META_PAGES.has(id)) continue
    nodes.push({ id, layer: layerOf(id), targets: extractLinks(content) })
  }

  const allIds = new Set(nodes.map(n => n.id))
  const outDeg = new Map(nodes.map(n => [n.id, 0]))
  const inDeg = new Map(nodes.map(n => [n.id, 0]))
  const broken = [] // wikilinks that resolve to nothing (and aren't meta targets)
  let edges = 0

  for (const n of nodes) {
    for (const t of n.targets) {
      const resolved = resolveTarget(t, allIds)
      if (resolved && resolved !== n.id) {
        edges++
        outDeg.set(n.id, outDeg.get(n.id) + 1)
        inDeg.set(resolved, inDeg.get(resolved) + 1)
      } else if (!resolved && !META_PAGES.has(t.replace(/^.*\//, '')) && !isAttachment(t)) {
        broken.push({ from: n.id, target: t })
      }
    }
  }

  const layers = ['notes', 'inbox', 'journal', 'projects', 'meetings', 'decisions', 'root']
  const layerStats = {}
  for (const L of layers) {
    const ns = nodes.filter(n => n.layer === L)
    if (!ns.length) continue
    layerStats[L] = {
      count: ns.length,
      zeroOut: ns.filter(n => outDeg.get(n.id) === 0).length,
      zeroIn: ns.filter(n => inDeg.get(n.id) === 0).length,
    }
  }

  // Wiki-layer view (what the LLM-wiki pattern actually densifies)
  const wikiNodes = nodes.filter(n => WIKI_LAYERS.has(n.layer))
  const wikiOrphans = wikiNodes.filter(n => inDeg.get(n.id) === 0 && outDeg.get(n.id) === 0)

  // Inbox connectivity: an inbox capture is "connected" once a wiki page cites it
  const inboxNodes = nodes.filter(n => n.layer === 'inbox')
  const inboxConnected = inboxNodes.filter(n => inDeg.get(n.id) > 0).length

  const topHubs = [...inDeg.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  const summary = {
    nodes: nodes.length,
    edges,
    linksPerNode: +(edges / Math.max(nodes.length, 1)).toFixed(2),
    zeroOutTotal: [...outDeg.values()].filter(d => d === 0).length,
    isolatedTotal: nodes.filter(n => inDeg.get(n.id) === 0 && outDeg.get(n.id) === 0).length,
    wikiNodes: wikiNodes.length,
    wikiOrphans: wikiOrphans.length,
    inboxNodes: inboxNodes.length,
    inboxConnected,
    broken: broken.length,
    topHubShare: topHubs.length ? +pct(topHubs[0][1], edges) : 0,
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(summary))
    return
  }

  console.log(`\n📊 Knowledge-graph connectivity — ${new Date().toISOString().slice(0, 10)}\n`)
  console.log(`Nodes (excl. meta): ${summary.nodes}   Edges: ${summary.edges}   Links/node: ${summary.linksPerNode}`)
  console.log(`Isolated (no in + no out): ${summary.isolatedTotal} (${pct(summary.isolatedTotal, summary.nodes)}%)`)
  console.log(`Broken wikilinks: ${summary.broken}`)

  console.log(`\nBy layer:`)
  console.log(`  ${'layer'.padEnd(10)} ${'count'.padStart(6)} ${'0-out'.padStart(7)} ${'0-in'.padStart(6)}`)
  for (const [L, s] of Object.entries(layerStats)) {
    console.log(`  ${L.padEnd(10)} ${String(s.count).padStart(6)} ${`${s.zeroOut}`.padStart(7)} ${`${s.zeroIn}`.padStart(6)}`)
  }

  console.log(`\nWiki layer (notes/projects/meetings/decisions/journal):`)
  console.log(`  pages: ${summary.wikiNodes}   fully-orphan (no in + no out): ${summary.wikiOrphans} (${pct(summary.wikiOrphans, summary.wikiNodes)}%)`)

  console.log(`\nInbox connectivity (cited by ≥1 wiki page):`)
  console.log(`  ${summary.inboxConnected}/${summary.inboxNodes} connected (${pct(summary.inboxConnected, summary.inboxNodes)}%) — ${summary.inboxNodes - summary.inboxConnected} uncited`)

  console.log(`\nTop hubs (in-degree):`)
  for (const [id, d] of topHubs) {
    console.log(`  ${String(d).padStart(3)}  ${id}  (${pct(d, edges)}% of edges)`)
  }

  if (broken.length) {
    console.log(`\nBroken wikilinks (first 15):`)
    for (const b of broken.slice(0, 15)) console.log(`  ${b.from} → ${b.target}`)
  }
  console.log('')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
