import type { ContentDetails } from "../../plugins/emitters/contentIndex"
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceRadial,
  forceX,
  forceY,
  select,
  drag as d3drag,
  zoom as d3zoom,
  zoomIdentity,
  easeQuadOut,
} from "d3"
import { registerEscapeHandler, removeAllChildren } from "./util"
import { FullSlug, SimpleSlug, getFullSlug, resolveRelative, simplifySlug } from "../../util/path"
import { D3Config } from "../Graph"

type NodeData = {
  id: SimpleSlug
  text: string
  tags: string[]
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
  vx?: number
  vy?: number
}

type LinkData = {
  source: NodeData
  target: NodeData
}

const localStorageKey = "graph-visited"
function getVisited(): Set<SimpleSlug> {
  return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? "[]"))
}
function addToVisited(slug: SimpleSlug) {
  const visited = getVisited()
  visited.add(slug)
  localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
}

const CATEGORY_COLORS: Record<string, string> = {
  "inbox/": "#201f87",
  "notes/": "#059669",
  "journal/": "#d97706",
  "meetings/": "#7c3aed",
  "decisions/": "#dc2626",
  "projects/": "#0891b2",
}

async function renderGraph(graph: HTMLElement, fullSlug: FullSlug) {
  const slug = simplifySlug(fullSlug)
  removeAllChildren(graph)

  // Race-condition guard
  const renderToken = String((Number(graph.dataset.renderToken) || 0) + 1)
  graph.dataset.renderToken = renderToken
  const isStale = () => graph.dataset.renderToken !== renderToken

  const cfg = JSON.parse(graph.dataset["cfg"]!) as D3Config
  const {
    drag: enableDrag,
    zoom: enableZoom,
    depth,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    showTags,
    removeTags,
    removeSlugs,
    focusOnHover,
    enableRadial,
  } = cfg

  const data: Map<SimpleSlug, ContentDetails> = new Map(
    Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
      simplifySlug(k as FullSlug),
      v,
    ]),
  )

  // Drop hidden slugs (entries ending in "/" match as prefix, others exactly).
  // Keeps hub pages like catalog/log and the raw inbox layer out of the graph.
  const isHiddenSlug = (s: SimpleSlug) =>
    (removeSlugs ?? []).some((p) => (p.endsWith("/") ? s.startsWith(p) : s === p))
  for (const k of [...data.keys()]) {
    if (isHiddenSlug(k)) data.delete(k)
  }

  // A tag only earns a node when it connects 2+ pages — singleton tags
  // cluster nothing and just dangle off their one note
  const tagUsage = new Map<string, number>()
  if (showTags) {
    for (const details of data.values()) {
      for (const t of details.tags ?? []) tagUsage.set(t, (tagUsage.get(t) ?? 0) + 1)
    }
  }

  // Build links + tag set
  const allLinks: { source: SimpleSlug; target: SimpleSlug }[] = []
  const allTags: SimpleSlug[] = []
  const validLinks = new Set(data.keys())
  for (const [source, details] of data.entries()) {
    for (const dest of details.links ?? []) {
      if (validLinks.has(dest)) allLinks.push({ source, target: dest })
    }
    if (showTags) {
      const localTags = details.tags
        .filter((t) => !removeTags.includes(t) && (tagUsage.get(t) ?? 0) >= 2)
        .map((t) => simplifySlug(("tags/" + t) as FullSlug))
      for (const tag of localTags) {
        if (!allTags.includes(tag)) allTags.push(tag)
        allLinks.push({ source, target: tag })
      }
    }
  }

  // BFS to compute neighborhood up to `depth` (or full graph if depth < 0)
  const neighborhood = new Set<SimpleSlug>()
  if (depth >= 0) {
    const wl: (SimpleSlug | "__S")[] = [slug, "__S"]
    let d = depth
    while (d >= 0 && wl.length > 0) {
      const cur = wl.shift()!
      if (cur === "__S") {
        d--
        wl.push("__S")
      } else {
        neighborhood.add(cur)
        for (const l of allLinks) {
          if (l.source === cur) wl.push(l.target)
          if (l.target === cur) wl.push(l.source)
        }
      }
    }
  } else {
    validLinks.forEach((id) => neighborhood.add(id))
    if (showTags) allTags.forEach((t) => neighborhood.add(t))
  }

  const nodes: NodeData[] = [...neighborhood].map((id) => ({
    id,
    text: id.startsWith("tags/") ? "#" + id.slice(5) : (data.get(id)?.title ?? id),
    tags: data.get(id)?.tags ?? [],
  }))
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]))
  const links: LinkData[] = allLinks
    .filter((l) => neighborhood.has(l.source) && neighborhood.has(l.target))
    .map((l) => ({ source: nodeIndex.get(l.source)!, target: nodeIndex.get(l.target)! }))

  // The nav event can fire before the sidebar is laid out, so wait until the
  // container has a real size before measuring (up to ~1s, then use fallbacks).
  let width = 0
  let height = 0
  for (let i = 0; i < 60; i++) {
    width = graph.offsetWidth
    height = graph.offsetHeight
    if (width > 100 && height > 100) break
    await new Promise(requestAnimationFrame)
  }
  if (isStale()) return () => {}
  width = width > 100 ? width : 300
  height = Math.max(height, 250)

  // Degree-based node radius
  const degree = new Map<string, number>()
  for (const l of links) {
    degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1)
    degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1)
  }
  const nodeRadius = (n: NodeData) => 4 + Math.sqrt(degree.get(n.id) ?? 0) * 1.5

  // CSS-var lookup
  const getCss = (key: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(key).trim()
  const css = {
    secondary: getCss("--secondary"),
    tertiary: getCss("--tertiary"),
    gray: getCss("--gray"),
    light: getCss("--light"),
    lightgray: getCss("--lightgray"),
    dark: getCss("--dark"),
    darkgray: getCss("--darkgray"),
    bodyFont: getCss("--bodyFont") || "sans-serif",
  }

  const nodeColor = (n: NodeData): string => {
    if (n.id === slug) return css.secondary
    for (const [prefix, hex] of Object.entries(CATEGORY_COLORS)) {
      if (n.id.startsWith(prefix)) return hex
    }
    if (n.id.startsWith("tags/")) return css.tertiary
    return css.gray
  }

  // Force simulation
  const simulation = forceSimulation<NodeData>(nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter(0, 0).strength(centerForce))
    // weak gravity keeps disconnected components from repelling out of frame
    .force("gravityX", forceX(0).strength(0.05))
    .force("gravityY", forceY(0).strength(0.05))
    .force("link", forceLink<NodeData, LinkData>(links).distance(linkDistance))
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n) + 2).iterations(2))
  if (enableRadial) {
    const r = (Math.min(width, height) / 2) * 0.8
    simulation.force("radial", forceRadial(r).strength(0.2))
  }

  if (isStale()) {
    simulation.stop()
    return () => {}
  }

  // Settle a throwaway copy of the layout purely to size the fit-to-view
  // transform. The visible simulation below starts scattered near center and
  // animates outward live (its own alpha budget drives that reveal), so we
  // don't want to spend it just to measure where the layout will land.
  type ScratchNode = { id: SimpleSlug; x: number; y: number }
  const scratchNodes: ScratchNode[] = nodes.map((n) => ({ id: n.id, x: 0, y: 0 }))
  const scratchLinks = links.map((l) => ({ source: l.source.id, target: l.target.id }))
  const scratchSim = forceSimulation<ScratchNode>(scratchNodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter(0, 0).strength(centerForce))
    .force("gravityX", forceX(0).strength(0.05))
    .force("gravityY", forceY(0).strength(0.05))
    .force(
      "link",
      forceLink<ScratchNode, { source: SimpleSlug; target: SimpleSlug }>(scratchLinks)
        .id((d) => d.id)
        .distance(linkDistance),
    )
    .force("collide", forceCollide<ScratchNode>((n) => nodeRadius(nodeIndex.get(n.id)!) + 2).iterations(2))
  if (enableRadial) {
    const r = (Math.min(width, height) / 2) * 0.8
    scratchSim.force("radial", forceRadial(r).strength(0.2))
  }
  scratchSim.stop()
  const preTickCount = depth < 0 ? 200 : 120
  for (let i = 0; i < preTickCount; i++) scratchSim.tick()

  // Scatter nodes near center so they animate outward on entry
  nodes.forEach((n) => {
    n.x = (Math.random() - 0.5) * 80
    n.y = (Math.random() - 0.5) * 80
  })

  // Build SVG
  const svg = select(graph)
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`)
    .attr(
      "style",
      "display:block; max-width:100%; height:100%; cursor:grab; user-select:none;",
    )
  const root = svg.append("g")

  // ── SVG defs: glow filter + radial gradients ──────────────────────────
  const defs = svg.append("defs")

  // Glow filter applied to hovered node
  const glowFilter = defs.append("filter")
    .attr("id", "node-glow")
    .attr("x", "-50%").attr("y", "-50%")
    .attr("width", "200%").attr("height", "200%")
  glowFilter.append("feGaussianBlur")
    .attr("in", "SourceGraphic").attr("stdDeviation", "3").attr("result", "blur")
  const glowMerge = glowFilter.append("feMerge")
  glowMerge.append("feMergeNode").attr("in", "blur")
  glowMerge.append("feMergeNode").attr("in", "SourceGraphic")

  // Gradient for the current (focused) page node
  const currentGrad = defs.append("radialGradient")
    .attr("id", "grad-current").attr("cx", "35%").attr("cy", "35%").attr("r", "65%")
  currentGrad.append("stop").attr("offset", "0%").attr("stop-color", "white").attr("stop-opacity", "0.65")
  currentGrad.append("stop").attr("offset", "100%").attr("stop-color", css.secondary)

  // Gradient per category
  for (const [key, color] of Object.entries(CATEGORY_COLORS)) {
    const grad = defs.append("radialGradient")
      .attr("id", `grad-${key.replace("/", "")}`).attr("cx", "35%").attr("cy", "35%").attr("r", "65%")
    grad.append("stop").attr("offset", "0%").attr("stop-color", "white").attr("stop-opacity", "0.5")
    grad.append("stop").attr("offset", "100%").attr("stop-color", color)
  }
  // ──────────────────────────────────────────────────────────────────────

  // Fit the settled (scratch) layout into the viewport. The viewBox is
  // centered on (0,0), so we scale around the layout's bounding-box center.
  // `scale` from the config caps how far a small graph may be magnified.
  const pad = 20
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const sn of scratchNodes) {
    const r = nodeRadius(nodeIndex.get(sn.id)!) + pad
    if (sn.x - r < minX) minX = sn.x - r
    if (sn.x + r > maxX) maxX = sn.x + r
    if (sn.y - r < minY) minY = sn.y - r
    if (sn.y + r > maxY) maxY = sn.y + r
  }
  const k = Math.min(scale ?? 1, width / (maxX - minX), height / (maxY - minY))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const fitTransform = zoomIdentity.translate(-k * cx, -k * cy).scale(k)

  // Zoom / pan
  if (enableZoom) {
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on("zoom", (e) => root.attr("transform", e.transform.toString()))
    svg.call(zoomBehavior as any)
    // seed the zoom state with the fit transform so user zoom composes with it
    svg.call((zoomBehavior as any).transform, fitTransform)
  } else {
    root.attr("transform", fitTransform.toString())
  }

  const linkSel = root
    .append("g")
    .attr("stroke-linecap", "round")
    .selectAll<SVGLineElement, LinkData>("line")
    .data(links)
    .join("line")
    .attr("stroke", (l) => {
      const src = l.source as NodeData
      for (const [prefix, color] of Object.entries(CATEGORY_COLORS)) {
        if (src.id.startsWith(prefix)) return color
      }
      return css.gray
    })
    .attr("stroke-width", 1.2)
    .attr("stroke-opacity", 0.45)
    // real wikilinks are solid; taxonomy (tag) links are dotted so the two
    // kinds of connection read differently at a glance
    .attr("stroke-dasharray", (l) =>
      l.source.id.startsWith("tags/") || l.target.id.startsWith("tags/") ? "2 4" : null,
    )

  const nodeSel = root
    .append("g")
    .selectAll<SVGCircleElement, NodeData>("circle")
    .data(nodes)
    .join("circle")
    .attr("r", nodeRadius)
    .attr("fill", (n) => {
      if (n.id.startsWith("tags/")) return css.light
      if (n.id === slug) return "url(#grad-current)"
      for (const [prefix] of Object.entries(CATEGORY_COLORS)) {
        if (n.id.startsWith(prefix)) return `url(#grad-${prefix.replace("/", "")})`
      }
      return nodeColor(n)
    })
    .attr("stroke", (n) => (n.id.startsWith("tags/") ? css.tertiary : "white"))
    .attr("stroke-width", (n) => (n.id.startsWith("tags/") ? 1.5 : 1))
    .classed("current-node", (n) => n.id === slug)
    .attr("cursor", "pointer")
    .on("click", (_e, n) => {
      window.location.href = resolveRelative(fullSlug, n.id as FullSlug)
    })

  const labelSel = root
    .append("g")
    .attr("font-family", css.bodyFont)
    .attr("font-size", `${fontSize}em`)
    .attr("fill", css.darkgray)
    .attr("pointer-events", "none")
    .attr("text-anchor", "start")
    .selectAll<SVGTextElement, NodeData>("text")
    .data(nodes)
    .join("text")
    .text((n) => n.text)
    .attr("dy", "0.35em")
    .attr("opacity", opacityScale)
    // halo behind label text so names stay readable over crossing links
    .attr("paint-order", "stroke")
    .attr("stroke", css.light)
    .attr("stroke-width", 3)

  function applyPositions() {
    linkSel
      .attr("x1", (l) => l.source.x!)
      .attr("y1", (l) => l.source.y!)
      .attr("x2", (l) => l.target.x!)
      .attr("y2", (l) => l.target.y!)
    nodeSel.attr("cx", (n) => n.x!).attr("cy", (n) => n.y!)
    labelSel.attr("x", (n) => n.x! + nodeRadius(n) + 4).attr("y", (n) => n.y!)
  }

  // Entry animation: staggered node reveal + simulation-driven positions
  svg.style("opacity", 0).transition().duration(400).style("opacity", 1)
  nodeSel.attr("opacity", 0)
    .transition().duration(350).ease(easeQuadOut)
    .delay((_, i) => i * 18)
    .attr("opacity", 1)
  labelSel.attr("opacity", 0)
    .transition().duration(350).ease(easeQuadOut)
    .delay((_, i) => i * 18 + 180)
    .attr("opacity", opacityScale)
  simulation.on("tick", applyPositions)
  simulation.on("end", () => {
    simulation.on("tick", null)
    simulation.on("end", null)
  })
  simulation.restart()

  // Hover: highlight neighborhood
  if (focusOnHover) {
    const neighborMap = new Map<string, Set<string>>()
    for (const n of nodes) neighborMap.set(n.id, new Set([n.id]))
    for (const l of links) {
      neighborMap.get(l.source.id)!.add(l.target.id)
      neighborMap.get(l.target.id)!.add(l.source.id)
    }

    nodeSel
      .on("mouseenter", (_e, n) => {
        const set = neighborMap.get(n.id)!
        nodeSel.transition().duration(200).ease(easeQuadOut).attr("opacity", (x) => (set.has(x.id) ? 1 : 0.2))
        labelSel.transition().duration(200).ease(easeQuadOut).attr("opacity", (x) => (set.has(x.id) ? 1 : 0.1))
        linkSel.transition().duration(200).ease(easeQuadOut).attr("stroke-opacity", (l) =>
          l.source.id === n.id || l.target.id === n.id ? 0.9 : 0.05,
        )
        nodeSel.filter((x) => x.id === n.id)
          .attr("filter", "url(#node-glow)")
          .transition("scale").duration(180).ease(easeQuadOut)
          .attr("r", (x) => nodeRadius(x) * 1.45)
      })
      .on("mouseleave", () => {
        nodeSel.attr("filter", null)
        nodeSel.transition().duration(200).ease(easeQuadOut).attr("opacity", 1)
        nodeSel.transition("scale").duration(200).ease(easeQuadOut).attr("r", nodeRadius)
        labelSel.transition().duration(200).ease(easeQuadOut).attr("opacity", opacityScale)
        linkSel.transition().duration(200).ease(easeQuadOut).attr("stroke-opacity", 0.45)
      })
  }

  // Drag — only restart simulation while dragging
  let isDragging = false
  if (enableDrag) {
    nodeSel.call(
      d3drag<SVGCircleElement, NodeData>()
        .on("start", (e, d) => {
          isDragging = true
          if (!e.active) {
            simulation.alphaTarget(0.3).restart()
            simulation.on("tick", applyPositions)
          }
          d.fx = d.x
          d.fy = d.y
        })
        .on("drag", (e, d) => {
          d.fx = e.x
          d.fy = e.y
        })
        .on("end", (e, d) => {
          isDragging = false
          if (!e.active) {
            simulation.alphaTarget(0)
            // Stop ticking after the simulation cools down
            setTimeout(() => {
              if (!isDragging) {
                simulation.stop()
                simulation.on("tick", null)
              }
            }, 1500)
          }
          d.fx = null
          d.fy = null
        }) as any,
    )
  }

  return () => {
    simulation.stop()
    simulation.on("tick", null)
    removeAllChildren(graph)
  }
}

let localGraphCleanups: (() => void)[] = []
let globalGraphCleanups: (() => void)[] = []

function cleanupLocalGraphs() {
  for (const c of localGraphCleanups) c()
  localGraphCleanups = []
}
function cleanupGlobalGraphs() {
  for (const c of globalGraphCleanups) c()
  globalGraphCleanups = []
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const slug = e.detail.url
  addToVisited(simplifySlug(slug))

  async function renderLocalGraph() {
    cleanupLocalGraphs()
    const localGraphContainers = document.getElementsByClassName("graph-container")
    for (const container of localGraphContainers) {
      localGraphCleanups.push(await renderGraph(container as HTMLElement, slug))
    }
  }

  await renderLocalGraph()
  const handleThemeChange = () => {
    void renderLocalGraph()
  }
  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    document.removeEventListener("themechange", handleThemeChange)
  })

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
  async function renderGlobalGraph() {
    const slug = getFullSlug(window)
    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = "1"

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)
      if (graphContainer) {
        const loader = document.createElement("div")
        loader.className = "graph-loader"
        loader.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg><span>Loading graph…</span>`
        graphContainer.appendChild(loader)
        try {
          const cleanup = await renderGraph(graphContainer, slug)
          globalGraphCleanups.push(cleanup)
        } catch (err) {
          console.error("[graph] render failed:", err)
          loader.innerHTML = `<span style="color: var(--secondary)">Graph failed to load.<br><small>${String(err).slice(0, 200)}</small></span>`
          return
        }
        loader.remove()
      }
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = ""
    }
  }

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyOpen = containers.some((c) => c.classList.contains("active"))
      if (anyOpen) hideGlobalGraph()
      else void renderGlobalGraph()
    }
  }

  const containerIcons = document.getElementsByClassName("global-graph-icon")
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener("click", renderGlobalGraph)
    window.addCleanup(() => icon.removeEventListener("click", renderGlobalGraph))
  })

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcutHandler)
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })
})
