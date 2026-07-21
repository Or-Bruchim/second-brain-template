
(function(){
  // Inline SVG icons — never break on encoding
  const ICONS = {
    text:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 9h1M9 13h6M9 17h6"/></svg>',
    link:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    image:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    pdf:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><text x="8" y="17" font-size="6" font-weight="700" stroke="none" fill="currentColor">PDF</text></svg>',
    docx:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 13h6M9 17h4"/></svg>',
    video:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="m10 9 5 3-5 3V9z" fill="currentColor"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
    twitter: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    note:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
  }
  const KIND_LABEL = { text:'Text', link:'Link', image:'Image', pdf:'PDF', docx:'DOCX', video:'Video', youtube:'YouTube', instagram:'Instagram', twitter:'Twitter/X', note:'Note' }
  const KIND_TAGS  = ['image','pdf','docx','text','video','youtube','instagram','twitter','link']
  const SKIP_TAGS  = new Set(['inbox','telegram','chat','manual','note', ...KIND_TAGS])

  function detectSource(tags) {
    if (tags.includes('telegram')) return 'telegram'
    if (tags.includes('chat')) return 'chat'
    return 'manual'
  }
  function detectKind(tags) {
    return KIND_TAGS.find(k => tags.includes(k)) || 'note'
  }

  // Pull a clean summary from the plain-text content field.
  // contentIndex.json strips markdown but preserves text — we take the
  // first substantive line that isn't the title or a "Note:/Why saved:" tag.
  function extractSummary(content, title) {
    if (!content) return ''
    const titleLower = (title || '').toLowerCase().trim()
    const parts = content.split(/\n+/).map(s => s.trim()).filter(Boolean)
    for (const p of parts) {
      if (p.length < 8) continue
      if (p.toLowerCase() === titleLower) continue
      if (/^(note|why saved|tags?|kind|source)\s*:/i.test(p)) continue
      return p.length > 240 ? p.slice(0, 237) + '…' : p
    }
    return ''
  }

  function parseTimestamp(slug) {
    // inbox/2026-04-28-1777362963000  →  ms epoch
    const m = slug.match(/-(\d{10,})$/)
    if (m) return Number(m[1])
    // inbox/2026-04-21-karpathy-llm-wiki  →  derive from date prefix
    const d = slug.match(/inbox\/(\d{4})-(\d{2})-(\d{2})/)
    if (d) return new Date(`${d[1]}-${d[2]}-${d[3]}T12:00:00`).getTime()
    return 0
  }

  function fmtTime(ts) {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })
  }
  function fmtDayKey(ts) {
    return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' })
  }
  function fmtDayLabel(key) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' })
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' }) })()
    if (key === today) return 'Today'
    if (key === yesterday) return 'Yesterday'
    const d = new Date(key + 'T12:00:00')
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
  }
  function fmtRel(ts) {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    if (h < 24) return `${h}h ago`
    if (d < 30) return `${d}d ago`
    return ''
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c])
  }

  async function initBrainActivity() {
    const root = document.getElementById('brain-activity-root')
    if (!root) return

    let entries
    try {
      const res = await fetch('/static/contentIndex.json', { credentials: 'same-origin' })
      const index = await res.json()
      entries = Object.values(index)
        .filter(n => n.slug && n.slug.startsWith('inbox/'))
        .map(n => {
          const tags = n.tags || []
          const ts = parseTimestamp(n.slug)
          return {
            slug: n.slug,
            title: n.title || '(untitled)',
            ts,
            source: detectSource(tags),
            kind: detectKind(tags),
            summary: extractSummary(n.content, n.title),
            tags: tags.filter(t => !SKIP_TAGS.has(t)),
          }
        })
        .sort((a, b) => b.ts - a.ts)
    } catch (err) {
      root.innerHTML = `<div class="ba-empty"><div class="ba-empty-title">Failed to load activity</div><div class="ba-empty-hint">${escapeHtml(err.message)}</div></div>`
      return
    }

    // ── State (persisted in URL hash) ─────────────────────
    const params = new URLSearchParams(location.hash.slice(1))
    let activeSource = params.get('src') || 'all'    // all | telegram | chat | manual
    let activeKind   = params.get('kind') || 'all'   // all | text | link | image | …
    let activeRange  = params.get('range') || 'all'  // all | 24h | 7d | 30d
    let searchQ      = params.get('q') || ''

    function persist() {
      const p = new URLSearchParams()
      if (activeSource !== 'all') p.set('src', activeSource)
      if (activeKind !== 'all') p.set('kind', activeKind)
      if (activeRange !== 'all') p.set('range', activeRange)
      if (searchQ) p.set('q', searchQ)
      const s = p.toString()
      history.replaceState(null, '', s ? `#${s}` : location.pathname)
    }

    function inRange(ts) {
      if (activeRange === 'all') return true
      const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[activeRange]
      return ms ? (Date.now() - ts) <= ms : true
    }

    function filtered() {
      const q = searchQ.toLowerCase()
      return entries.filter(e => {
        if (activeSource !== 'all' && e.source !== activeSource) return false
        if (activeKind !== 'all' && e.kind !== activeKind) return false
        if (!inRange(e.ts)) return false
        if (q) {
          const hay = `${e.title} ${e.summary} ${e.tags.join(' ')}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
    }

    function counts(field) {
      const acc = Object.create(null)
      for (const e of entries) acc[e[field]] = (acc[e[field]] || 0) + 1
      return acc
    }

    function sourceBadge(src) {
      const map = { telegram: ['tg', 'Telegram'], chat: ['chat', 'Chat'], manual: ['manual', 'Manual'] }
      const [cls, label] = map[src] || map.manual
      return `<span class="ba-source ${cls}">${label}</span>`
    }
    function kindBadge(kind) {
      return `<span class="ba-kind">${ICONS[kind] || ICONS.note}<span>${KIND_LABEL[kind] || 'Note'}</span></span>`
    }

    function render() {
      const rows = filtered()
      const srcCounts = counts('source')
      const kindCounts = counts('kind')

      const sourceBtns = [
        ['all', 'All', entries.length],
        ['telegram', 'Telegram', srcCounts.telegram || 0],
        ['chat', 'Chat', srcCounts.chat || 0],
        ['manual', 'Manual', srcCounts.manual || 0],
      ].map(([k, label, n]) => `<button class="ba-btn ${activeSource===k?'active':''}" data-src="${k}">${label}<span class="ba-count-pill">${n}</span></button>`).join('')

      const kindOrder = ['all', 'text', 'link', 'image', 'pdf', 'video', 'youtube', 'instagram', 'twitter', 'docx', 'note']
      const kindBtns = kindOrder
        .filter(k => k === 'all' || (kindCounts[k] || 0) > 0)
        .map(k => {
          const n = k === 'all' ? entries.length : (kindCounts[k] || 0)
          const label = k === 'all' ? 'All' : (KIND_LABEL[k] || k)
          return `<button class="ba-btn ${activeKind===k?'active':''}" data-kind="${k}">${label}<span class="ba-count-pill">${n}</span></button>`
        }).join('')

      const rangeBtns = [['all','All time'],['24h','Last 24h'],['7d','Last 7 days'],['30d','Last 30 days']]
        .map(([k, label]) => `<button class="ba-btn ${activeRange===k?'active':''}" data-range="${k}">${label}</button>`).join('')

      // Group rows by day
      const groups = {}
      for (const e of rows) {
        const k = fmtDayKey(e.ts)
        ;(groups[k] ||= []).push(e)
      }
      const groupKeys = Object.keys(groups).sort((a,b) => b.localeCompare(a))

      const groupsHtml = groupKeys.length === 0 ? `
        <div class="ba-empty">
          <div class="ba-empty-title">No matches</div>
          <div class="ba-empty-hint">Try clearing filters or search</div>
        </div>` : groupKeys.map(k => `
          <div class="ba-day">
            <span class="ba-day-date">${fmtDayLabel(k)}</span>
            <span class="ba-day-rel">${fmtRel(groups[k][0].ts)}</span>
            <span class="ba-day-count">${groups[k].length} ${groups[k].length === 1 ? 'entry' : 'entries'}</span>
          </div>
          ${groups[k].map(e => `
            <div class="ba-card">
              <div class="ba-time">${fmtTime(e.ts)}</div>
              <div class="ba-body">
                <div class="ba-title-row">
                  <a class="ba-title" href="/${e.slug}">${escapeHtml(e.title)}</a>
                </div>
                ${e.summary ? `<div class="ba-summary">${escapeHtml(e.summary)}</div>` : ''}
                ${e.tags.length ? `<div class="ba-tags">${e.tags.map(t => `<span class="ba-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
              </div>
              <div class="ba-meta">
                ${sourceBadge(e.source)}
                ${kindBadge(e.kind)}
              </div>
            </div>
          `).join('')}
        `).join('')

      root.innerHTML = `
        <div class="ba-toolbar">
          <div class="ba-group"><span class="ba-group-label">Source</span>${sourceBtns}</div>
          <div class="ba-group"><span class="ba-group-label">Kind</span>${kindBtns}</div>
          <div class="ba-group"><span class="ba-group-label">When</span>${rangeBtns}</div>
          <input class="ba-search" type="search" placeholder="Search title, summary, tags…" value="${escapeHtml(searchQ)}" />
          <div class="ba-stats"><strong>${rows.length}</strong> of <strong>${entries.length}</strong></div>
        </div>
        ${groupsHtml}
      `

      root.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => { activeSource = b.dataset.src; persist(); render() }))
      root.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { activeKind = b.dataset.kind; persist(); render() }))
      root.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { activeRange = b.dataset.range; persist(); render() }))
      const search = root.querySelector('.ba-search')
      if (search) {
        search.addEventListener('input', e => { searchQ = e.target.value; persist(); render() })
        // Don't steal focus on every render — restore caret on user input only
      }
    }

    render()
  }

  // Run on direct load and on every Quartz SPA navigation
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrainActivity)
  } else {
    initBrainActivity()
  }
  document.addEventListener('nav', initBrainActivity)
})()
