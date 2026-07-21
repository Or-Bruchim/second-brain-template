
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
  function nodeRadius(deg) { return 5 + Math.sqrt(deg * 3) }

  function initHomeGraph() {
    const container = document.getElementById('hg-container')
    if (!container || !window.d3) return
    // Clear previous render (SPA re-navigation)
    container.querySelectorAll('svg').forEach(el => el.remove())
    document.getElementById('hg-loading')?.remove()

    const d3 = window.d3
    fetch('/static/contentIndex.json', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(index => buildHomeGraph(d3, container, index))
      .catch(() => {})
  }

  function buildHomeGraph(d3, container, index) {
    const nodeMap = new Map()
    for (const [slug, data] of Object.entries(index)) {
      nodeMap.set(slug, {
        id: slug,
        title: data.title || slug.split('/').pop(),
        outLinks: new Set((data.links || []).map(String)),
      })
    }

    // Edges with bidirectional strength
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

    const inDeg = new Map()
    for (const l of links) {
      inDeg.set(l.source, (inDeg.get(l.source) || 0) + l.strength)
      inDeg.set(l.target, (inDeg.get(l.target) || 0) + l.strength)
    }

    const W = container.clientWidth || 600
    const H = 420

    const svg = d3.create('svg')
      .attr('width', W).attr('height', H)
      .style('display', 'block')
    container.appendChild(svg.node())

    const g = svg.append('g')

    svg.call(
      d3.zoom().scaleExtent([0.2, 8])
        .on('zoom', e => g.attr('transform', e.transform))
    )

    const sim = d3.forceSimulation(nodes)
      .force('link',   d3.forceLink(links).id(d => d.id).distance(75).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-220))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide(d => nodeRadius(inDeg.get(d.id) || 0) + 8))

    const link = g.append('g')
      .selectAll('line').data(links).join('line')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-width', d => d.strength === 2 ? 3 : 1.2)
      .attr('stroke-opacity', d => d.strength === 2 ? 0.7 : 0.4)

    const isTag = d => d.id.startsWith('tags/')
    const node = g.append('g')
      .selectAll('circle').data(nodes).join('circle')
      .attr('r', d => isTag(d) ? nodeRadius(inDeg.get(d.id) || 0) * 0.85 : nodeRadius(inDeg.get(d.id) || 0))
      .attr('fill',         d => isTag(d) ? '#f8fafc' : nodeColor(d.id))
      .attr('stroke',       d => isTag(d) ? '#94a3b8' : 'white')
      .attr('stroke-width', 2)
      .attr('cursor', 'pointer')
      .call(
        d3.drag()
          .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
          .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
      )
      .on('click', (e, d) => { window.location.href = '/' + d.id })
      .on('mouseenter', (e, d) => {
        const neighbors = new Set([d.id])
        links.forEach(l => {
          if (l.source.id === d.id) neighbors.add(l.target.id)
          if (l.target.id === d.id) neighbors.add(l.source.id)
        })
        node.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.15)
        link.attr('opacity', l => (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.05)
        label.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.05)
        const tip = document.getElementById('hg-tooltip')
        if (tip) {
          tip.textContent = d.title
          tip.style.left = (e.offsetX + 14) + 'px'
          tip.style.top  = (e.offsetY - 10) + 'px'
          tip.style.opacity = '1'
        }
      })
      .on('mouseleave', () => {
        node.attr('opacity', 1); link.attr('opacity', 1); label.attr('opacity', 1)
        const tip = document.getElementById('hg-tooltip')
        if (tip) tip.style.opacity = '0'
      })

    const label = g.append('g')
      .selectAll('text').data(nodes).join('text')
      .text(d => d.id.startsWith('tags/') ? '#' + d.title : d.title)
      .attr('font-size', 10).attr('fill', '#334155')
      .attr('pointer-events', 'none').attr('dy', '0.35em')

    sim.on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
      node.attr('cx', d => d.x).attr('cy', d => d.y)
      label.attr('x', d => d.x + nodeRadius(inDeg.get(d.id) || 0) + 4).attr('y', d => d.y)
    })
  }

  let tries = 0
  function waitForD3() {
    if (window.d3) { initHomeGraph(); return }
    if (++tries < 30) setTimeout(waitForD3, 100)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForD3)
  } else {
    waitForD3()
  }
  document.addEventListener('nav', () => { tries = 0; waitForD3() })
})()
