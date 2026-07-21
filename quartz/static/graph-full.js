
(function () {
  const CATEGORIES = [
    { prefix: 'inbox/',     color: '#201f87', label: 'Inbox' },
    { prefix: 'notes/',     color: '#059669', label: 'Notes' },
    { prefix: 'journal/',   color: '#d97706', label: 'Journal' },
    { prefix: 'meetings/',  color: '#7c3aed', label: 'Meetings' },
    { prefix: 'decisions/', color: '#dc2626', label: 'Decisions' },
    { prefix: 'projects/',  color: '#0891b2', label: 'Projects' },
    { prefix: 'tags/',      color: '#94a3b8', label: 'Tags' },
  ]
  const DEFAULT_COLOR = '#355872'

  function nodeColor(id) {
    for (const c of CATEGORIES) if (id.startsWith(c.prefix)) return c.color
    return DEFAULT_COLOR
  }

  function nodeRadius(deg) {
    return 6 + Math.sqrt(deg * 4)
  }

  function getCssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  }

  // ── Lifecycle state ────────────────────────────────────────────────────────
  let activeSim = null
  let activeCleanups = []

  function cleanupGraph() {
    if (activeSim) { activeSim.stop(); activeSim = null }
    activeCleanups.forEach(fn => fn())
    activeCleanups = []
  }

  // ── D3 loading ─────────────────────────────────────────────────────────────
  // One-shot Promise instead of error-prone polling
  const d3Ready = new Promise(resolve => {
    if (window.d3) { resolve(window.d3); return }
    window.addEventListener('load', () => resolve(window.d3), { once: true })
  })

  function initGraph() {
    const overlay = document.getElementById('gf-overlay')
    if (!overlay) return

    cleanupGraph()

    const loading = document.getElementById('gf-loading')

    d3Ready.then(d3 => {
      if (!document.getElementById('gf-overlay')) return // navigated away
      fetch('/static/contentIndex.json', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(index => buildGraph(d3, index))
        .catch(err => {
          if (loading) loading.textContent = 'Failed to load graph: ' + err.message
        })
    })
  }

  function buildGraph(d3, index) {
    if (!document.getElementById('gf-overlay')) return // navigated away during fetch

    document.getElementById('gf-loading')?.remove()

    // ── Build node map ─────────────────────────────────────────────────────
    const nodeMap = new Map()
    for (const [slug, data] of Object.entries(index)) {
      nodeMap.set(slug, {
        id: slug,
        title: data.title || slug.split('/').pop(),
        tags: data.tags || [],
        outLinks: new Set((data.links || []).map(String)),
      })
    }

    // Edges — bidirectional edges get strength 2
    const edgeMap = new Map()
    for (const [id, node] of nodeMap) {
      for (const target of node.outLinks) {
        if (!nodeMap.has(target)) continue
        const [a, b] = [id, target].sort()
        const key = `${a}\x00${b}`
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1)
      }
    }

    const nodes = [...nodeMap.values()]
    const links = [...edgeMap.entries()].map(([key, strength]) => {
      const [source, target] = key.split('\x00')
      return { source, target, strength }
    })

    // Degree for node sizing
    const inDeg = new Map()
    for (const l of links) {
      inDeg.set(l.target, (inDeg.get(l.target) || 0) + l.strength)
      inDeg.set(l.source, (inDeg.get(l.source) || 0) + l.strength)
    }

    // ── CSS variables (resolved once; SVG attrs don't support var()) ───────
    const css = {
      linkStroke:  getCssVar('--lightgray', '#cbd5e1'),
      labelFill:   getCssVar('--darkgray',  '#334155'),
      tagStroke:   getCssVar('--tertiary',  '#94a3b8'),
      tagFill:     getCssVar('--light',     '#f8fafc'),
    }

    const isTag = d => d.id.startsWith('tags/')

    const width  = window.innerWidth
    const height = window.innerHeight

    const svg = d3.select('#gf-svg').attr('width', width).attr('height', height)
    const g   = svg.append('g')

    // Zoom / pan
    const zoomBehavior = d3.zoom()
      .scaleExtent([0.08, 12])
      .on('zoom', e => g.attr('transform', e.transform))
    svg.call(zoomBehavior)

    // Fit the settled layout into the viewport (seeds the zoom state so
    // user zoom/pan composes with it). Reads live dimensions — the window
    // can report 0×0 while the page is still initializing.
    function fitToView() {
      const W = window.innerWidth || width || 1280
      const H = window.innerHeight || height || 720
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const n of nodes) {
        const r = nodeRadius(inDeg.get(n.id) || 0) + 60 // room for labels
        if (n.x - r < minX) minX = n.x - r
        if (n.x + r > maxX) maxX = n.x + r
        if (n.y - r < minY) minY = n.y - r
        if (n.y + r > maxY) maxY = n.y + r
      }
      let k = 0.95 * Math.min(W / (maxX - minX), H / (maxY - minY))
      if (!isFinite(k) || k <= 0) k = 1
      k = Math.min(1.5, k)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const t = d3.zoomIdentity
        .translate(W / 2 - k * cx, H / 2 - k * cy)
        .scale(k)
      svg.call(zoomBehavior.transform, t)
    }

    // ── Force simulation ───────────────────────────────────────────────────
    // Simulates around the origin — screen placement is handled entirely by
    // the zoom transform (fitToView), so window size never affects the layout.
    const sim = d3.forceSimulation(nodes)
      .force('link',    d3.forceLink(links).id(d => d.id).distance(55).strength(0.6))
      .force('charge',  d3.forceManyBody().strength(-70))
      .force('center',  d3.forceCenter(0, 0).strength(0.25))
      // weak gravity keeps disconnected nodes near the main cluster
      .force('gravityX', d3.forceX(0).strength(0.05))
      .force('gravityY', d3.forceY(0).strength(0.05))
      .force('collide', d3.forceCollide(d => nodeRadius(inDeg.get(d.id) || 0) + 10))

    // ── Pre-ticking — stable layout before first paint ────────────────────
    sim.stop()
    const preTickCount = Math.min(300, Math.max(120, Math.ceil(nodes.length * 0.8)))
    for (let i = 0; i < preTickCount; i++) sim.tick()

    activeSim = sim
    fitToView()

    // ── Render (initial positions already computed) ───────────────────────
    const link = g.append('g').attr('class', 'gf-links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', css.linkStroke)
      .attr('stroke-width', d => d.strength === 2 ? 3.5 : 1.2)
      .attr('stroke-opacity', d => d.strength === 2 ? 0.75 : 0.45)

    const node = g.append('g').attr('class', 'gf-nodes')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r',            d => isTag(d) ? nodeRadius(inDeg.get(d.id) || 0) * 0.85 : nodeRadius(inDeg.get(d.id) || 0))
      .attr('fill',         d => isTag(d) ? css.tagFill : nodeColor(d.id))
      .attr('stroke',       d => isTag(d) ? css.tagStroke : 'white')
      .attr('stroke-width', 2)
      .attr('cursor', 'pointer')

    const label = g.append('g').attr('class', 'gf-labels')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => isTag(d) ? '#' + d.title : d.title)
      .attr('font-size', 11)
      .attr('fill', css.labelFill)
      .attr('pointer-events', 'none')
      .attr('dy', '0.35em')

    // Apply pre-ticked positions immediately
    function applyPositions() {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
      node.attr('cx', d => d.x).attr('cy', d => d.y)
      label.attr('x', d => d.x + nodeRadius(inDeg.get(d.id) || 0) + 5).attr('y', d => d.y)
    }
    applyPositions()

    // ── Hover ─────────────────────────────────────────────────────────────
    node
      .on('mouseenter', (e, d) => {
        const neighbors = new Set([d.id])
        links.forEach(l => {
          if (l.source.id === d.id) neighbors.add(l.target.id)
          if (l.target.id === d.id) neighbors.add(l.source.id)
        })
        node.attr('opacity',  n => neighbors.has(n.id) ? 1 : 0.12)
        link.attr('opacity',  l => (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.04)
        label.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.06)
        const tip = document.getElementById('gf-tooltip')
        if (tip) {
          tip.textContent    = d.title
          tip.style.left     = (e.clientX + 16) + 'px'
          tip.style.top      = (e.clientY - 10) + 'px'
          tip.style.opacity  = '1'
        }
      })
      .on('mouseleave', () => {
        node.attr('opacity',  1)
        link.attr('opacity',  1)
        label.attr('opacity', 1)
        const tip = document.getElementById('gf-tooltip')
        if (tip) tip.style.opacity = '0'
        // Re-apply search filter if active
        const q = document.getElementById('gf-search')?.value.trim().toLowerCase()
        if (q) applySearch(q)
      })

    node.on('click', (e, d) => { window.location.href = '/' + d.id })

    // ── Drag — only restarts sim while dragging ───────────────────────────
    let isDragging = false
    node.call(
      d3.drag()
        .on('start', (e, d) => {
          isDragging = true
          if (!e.active) { sim.alphaTarget(0.3).restart(); sim.on('tick', applyPositions) }
          d.fx = d.x; d.fy = d.y
        })
        .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
        .on('end',   (e, d) => {
          isDragging = false
          if (!e.active) {
            sim.alphaTarget(0)
            setTimeout(() => {
              if (!isDragging) { sim.stop(); sim.on('tick', null) }
            }, 1500)
          }
          d.fx = null; d.fy = null
        })
    )

    // ── Resize ────────────────────────────────────────────────────────────
    function onResize() {
      svg.attr('width', window.innerWidth).attr('height', window.innerHeight)
      fitToView()
    }
    window.addEventListener('resize', onResize)
    activeCleanups.push(() => window.removeEventListener('resize', onResize))

    // ── Keyboard ──────────────────────────────────────────────────────────
    function onKeydown(e) {
      if (e.key === 'Escape') history.back()
    }
    document.addEventListener('keydown', onKeydown)
    activeCleanups.push(() => document.removeEventListener('keydown', onKeydown))

    // ── Search ────────────────────────────────────────────────────────────
    const searchInput = document.getElementById('gf-search')
    const countEl     = document.getElementById('gf-count')
    if (countEl) countEl.textContent = nodes.length + ' nodes · ' + links.length + ' links'

    function applySearch(q) {
      if (!q) {
        node.attr('opacity', 1).attr('stroke', d => isTag(d) ? css.tagStroke : 'white').attr('stroke-width', 2)
        label.attr('opacity', 1)
        link.attr('opacity', 1)
        if (countEl) countEl.textContent = nodes.length + ' nodes · ' + links.length + ' links'
        return
      }
      const matched = new Set(
        nodes.filter(n => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map(n => n.id)
      )
      node
        .attr('opacity',      n => matched.has(n.id) ? 1 : 0.1)
        .attr('stroke',       n => matched.has(n.id) ? '#fbbf24' : 'white')
        .attr('stroke-width', n => matched.has(n.id) ? 3.5 : 2)
      label.attr('opacity',  n => matched.has(n.id) ? 1 : 0.08)
      link.attr('opacity', 0.07)
      if (countEl) countEl.textContent = matched.size + ' matched'
    }

    function onSearch() {
      applySearch(searchInput.value.trim().toLowerCase())
    }

    if (searchInput) {
      searchInput.addEventListener('input', onSearch)
      activeCleanups.push(() => searchInput.removeEventListener('input', onSearch))
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGraph)
  } else {
    initGraph()
  }

  document.addEventListener('nav', () => { cleanupGraph(); initGraph() })
})()
