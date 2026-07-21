
(function () {
  const ICONS = {
    text:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 9h1M9 13h6M9 17h6"/></svg>',
    link:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    image:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    video:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8z"/></svg>',
    note:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
    telegram:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 3-8.97 5.96L2 5l3.64 8.82L2 21l7.91-3.05L22 21 19.5 3z"/></svg>',
    chat:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    clock:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    inbox:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    sparkle:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287z"/></svg>',
    pages:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    flame:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
    tag:       '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>',
  }

  const KIND_TAGS = ['image','pdf','docx','text','video','youtube','instagram','twitter','link']
  const META_TAGS = new Set(['inbox','note','user','telegram','chat','manual','image','pdf','docx','text','video','youtube','instagram','twitter','link'])

  function detectSource(tags) {
    if (tags.includes('telegram')) return 'telegram'
    if (tags.includes('chat')) return 'chat'
    return 'manual'
  }
  function detectKind(tags) {
    return KIND_TAGS.find(k => tags.includes(k)) || 'note'
  }
  function parseTimestamp(slug) {
    const m = slug.match(/-(\d{10,})$/)
    if (m) return Number(m[1])
    const d = slug.match(/inbox\/(\d{4})-(\d{2})-(\d{2})/)
    if (d) return new Date(`${d[1]}-${d[2]}-${d[3]}T12:00:00`).getTime()
    return 0
  }
  function fmtRel(ts) {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000)
    if (m < 1)  return 'just now'
    if (m < 60) return `${m}m ago`
    if (h < 24) return `${h}h ago`
    if (d < 2)  return 'yesterday'
    if (d < 7)  return `${d}d ago`
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c])
  }

  function dayKey(ts) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }

  function calcStreak(entries) {
    if (!entries.length) return 0
    const days = new Set(entries.map(e => dayKey(e.ts)))
    const todayStr = dayKey(Date.now())
    const yestStr  = dayKey(Date.now() - 86400000)
    if (!days.has(todayStr) && !days.has(yestStr)) return 0
    let streak = 0
    let check = days.has(todayStr) ? Date.now() : Date.now() - 86400000
    while (days.has(dayKey(check))) { streak++; check -= 86400000 }
    return streak
  }

  function topTags(entries, n) {
    const counts = {}
    entries.forEach(e => {
      (e.rawTags || []).forEach(t => {
        if (!META_TAGS.has(t)) counts[t] = (counts[t] || 0) + 1
      })
    })
    return Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, n)
  }

  function shortPreview(content) {
    if (!content) return ''
    // Strip markdown-ish artifacts and take first meaningful sentence
    const clean = content
      .replace(/^#+\s+.*/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean.length <= 90) return clean
    const cut = clean.slice(0, 90).lastIndexOf(' ')
    return clean.slice(0, cut > 40 ? cut : 90) + '…'
  }

  async function initHomeDashboard() {
    const root = document.getElementById('hd-root')
    if (!root) return

    let index, entries
    try {
      const res = await fetch('/static/contentIndex.json', { credentials: 'same-origin', cache: 'no-cache' })
      index = await res.json()
      entries = Object.values(index)
        .filter(n => n.slug && n.slug.startsWith('inbox/'))
        .map(n => ({
          slug:    n.slug,
          title:   n.title || '(untitled)',
          ts:      parseTimestamp(n.slug),
          source:  detectSource(n.tags || []),
          kind:    detectKind(n.tags || []),
          rawTags: n.tags || [],
          preview: shortPreview(n.content || ''),
        }))
        .filter(e => e.ts > 0)
        .sort((a, b) => b.ts - a.ts)
    } catch {
      root.innerHTML = ''
      return
    }

    if (!entries.length) { root.innerHTML = ''; return }

    const now       = Date.now()
    const totalNotes = Object.keys(index).length
    const total     = entries.length
    const week      = entries.filter(e => (now - e.ts) < 7 * 86400000).length
    const lastTs    = entries[0].ts
    const streak    = calcStreak(entries)
    const tags      = topTags(entries, 6)
    const recent    = entries.slice(0, 5)

    const sourceColor = { telegram: '#0088cc', chat: '#201f87', manual: '#64748b' }
    const kindIcon    = k => ICONS[k] || ICONS.note

    const streakLabel = streak > 0
      ? `<span style="color:#f97316">${streak}</span> day${streak !== 1 ? 's' : ''}`
      : '–'
    const streakIcon  = streak >= 3 ? ICONS.flame : ICONS.sparkle

    const tagsHtml = tags.length ? `
<div style="margin-bottom:16px">
  <div class="hd-section-header">
    <span class="hd-section-title">${ICONS.tag}&nbsp;Top topics</span>
  </div>
  <div class="hd-tags">
    ${tags.map(([t, c]) => `<a href="/tags/${encodeURIComponent(t)}" class="hd-tag">#${escapeHtml(t)}<span class="hd-tag-count">${c}</span></a>`).join('')}
  </div>
</div>` : ''

    root.innerHTML = `
<div class="hd-wrap">
  <div class="hd-stats">
    <div class="hd-stat">
      <span class="hd-stat-icon">${ICONS.clock}</span>
      <div>
        <div class="hd-stat-val">${fmtRel(lastTs)}</div>
        <div class="hd-stat-lbl">last capture</div>
      </div>
    </div>
    <div class="hd-stat-sep"></div>
    <div class="hd-stat">
      <span class="hd-stat-icon">${ICONS.pages}</span>
      <div>
        <div class="hd-stat-val">${totalNotes}</div>
        <div class="hd-stat-lbl">total notes</div>
      </div>
    </div>
    <div class="hd-stat-sep"></div>
    <div class="hd-stat">
      <span class="hd-stat-icon" style="${streak >= 3 ? 'color:#f97316' : ''}">${streakIcon}</span>
      <div>
        <div class="hd-stat-val">${streakLabel}</div>
        <div class="hd-stat-lbl">streak</div>
      </div>
    </div>
    <div class="hd-stat-sep"></div>
    <div class="hd-stat">
      <span class="hd-stat-icon">${ICONS.inbox}</span>
      <div>
        <div class="hd-stat-val">${week}</div>
        <div class="hd-stat-lbl">this week</div>
      </div>
    </div>
    <div class="hd-stat-sep"></div>
    <div class="hd-stat">
      <span class="hd-stat-icon">${ICONS.note}</span>
      <div>
        <div class="hd-stat-val">${total}</div>
        <div class="hd-stat-lbl">captures</div>
      </div>
    </div>
  </div>

  ${tagsHtml}

  <div class="hd-section-header">
    <span class="hd-section-title">Recent captures</span>
    <a href="/activity" class="hd-view-all">View all →</a>
  </div>

  <div class="hd-feed">
    ${recent.map(e => `
    <a href="/${escapeHtml(e.slug)}" class="hd-item">
      <span class="hd-item-icon" style="color:${sourceColor[e.source]}">${kindIcon(e.kind)}</span>
      <span class="hd-item-body">
        <span class="hd-item-title">${escapeHtml(e.title)}</span>
        ${e.preview ? `<span class="hd-item-preview">${escapeHtml(e.preview)}</span>` : ''}
      </span>
      <span class="hd-item-meta">
        <span class="hd-item-src hd-src-${escapeHtml(e.source)}">${ICONS[e.source] || ''}${escapeHtml(e.source)}</span>
        <span class="hd-item-time">${fmtRel(e.ts)}</span>
      </span>
    </a>`).join('')}
  </div>
</div>`
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHomeDashboard)
  } else {
    initHomeDashboard()
  }

  document.addEventListener('nav', initHomeDashboard)
})()
