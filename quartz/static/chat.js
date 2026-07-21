(function () {
  const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev'
  const K_PASS = 'or-brain-passphrase'
  const K_HISTORY = 'or-brain-chat-history'
  const K_OPEN = 'or-brain-chat-open'
  const MAX_SIZE = 10 * 1024 * 1024

  let history = []
  try { history = JSON.parse(localStorage.getItem(K_HISTORY) || '[]') } catch {}
  let pendingAttachment = null

  const btn = document.createElement('button')
  btn.id = 'brain-chat-btn'
  btn.setAttribute('aria-label', 'Chat with Brain')
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
  document.body.appendChild(btn)

  const drawer = document.createElement('div')
  drawer.id = 'brain-chat-drawer'
  drawer.innerHTML = `
    <div class="brain-chat-header">
      <div class="brain-chat-title">🧠 <strong>Brain</strong></div>
      <div class="brain-chat-actions">
        <button class="brain-chat-new" title="New chat" aria-label="New chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.5L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.5L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
        <button class="brain-chat-close" title="Close" aria-label="Close">×</button>
      </div>
    </div>
    <div class="brain-chat-messages" id="brain-chat-messages"></div>
    <div class="brain-chat-attachment-preview" id="brain-chat-attachment-preview" hidden></div>
    <form class="brain-chat-input-form" id="brain-chat-form" autocomplete="off">
      <button type="button" class="brain-chat-attach" title="Attach file" aria-label="Attach file">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <input type="file" id="brain-chat-file" hidden accept="image/*,.pdf,.txt,.md,.docx,.markdown" />
      <input type="text" id="brain-chat-input" placeholder="Ask your Brain..." autocomplete="off" />
      <button type="submit" aria-label="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
    </form>
    <div class="brain-chat-dropzone" id="brain-chat-dropzone">Drop file to attach</div>
  `
  document.body.appendChild(drawer)

  const messagesEl = drawer.querySelector('#brain-chat-messages')
  const form = drawer.querySelector('#brain-chat-form')
  const input = drawer.querySelector('#brain-chat-input')
  const fileInput = drawer.querySelector('#brain-chat-file')
  const attachBtn = drawer.querySelector('.brain-chat-attach')
  const previewEl = drawer.querySelector('#brain-chat-attachment-preview')
  const dropzone = drawer.querySelector('#brain-chat-dropzone')

  function saveHistory() {
    const trimmed = history.slice(-50)
    try {
      localStorage.setItem(K_HISTORY, JSON.stringify(trimmed))
    } catch (e) {
      console.warn('[brain-chat] localStorage save failed:', e)
    }
  }
  function renderAll() {
    messagesEl.innerHTML = ''
    if (history.length === 0) {
      messagesEl.innerHTML = `<div class="brain-chat-empty">
        <div>🧠</div>
        <div><strong>Ask your Brain anything</strong></div>
        <div class="brain-chat-hint">Ask about saved notes · attach an image or PDF · drop a file anywhere</div>
      </div>`
      return
    }
    history.forEach((m, idx) => renderMessage(m, idx))
  }
  function renderMessage(m, idx) {
    const el = document.createElement('div')
    el.className = `brain-chat-msg brain-chat-msg-${m.role}`
    if (m.attachmentEcho) {
      const chip = document.createElement('div')
      chip.className = 'brain-chat-att-chip'
      chip.innerHTML = `${iconFor(m.attachmentEcho.kind)} ${escapeHtml(m.attachmentEcho.name)} <span>${fmtBytes(m.attachmentEcho.size)}</span>`
      el.appendChild(chip)
    }
    const content = document.createElement('div')
    content.className = 'brain-chat-bubble'
    content.innerHTML = renderMarkdown(m.content)
    el.appendChild(content)
    if (m.sources?.length) {
      const sources = document.createElement('div')
      sources.className = 'brain-chat-sources'
      sources.innerHTML = m.sources.map(s => `<a href="${escapeHtml(s.url)}" class="brain-chat-source" target="_blank" rel="noopener">📄 ${escapeHtml(s.title)}</a>`).join('')
      el.appendChild(sources)
    }
    if (m.role === 'assistant' && m.canSave && !m.savedUrl) {
      const saveBtn = document.createElement('button')
      saveBtn.className = 'brain-chat-save-btn'
      saveBtn.innerHTML = '💾 Save to Brain'
      saveBtn.addEventListener('click', () => saveToBrain(idx, saveBtn))
      el.appendChild(saveBtn)
    }
    if (m.savedUrl) {
      const card = document.createElement('div')
      card.className = 'brain-chat-saved-card'
      const tagsHtml = (m.savedTags || []).filter(t => t !== 'chat' && t !== 'inbox').map(t => `<span class="brain-chat-saved-tag">#${escapeHtml(t)}</span>`).join('')
      card.innerHTML = `
        <div class="brain-chat-saved-head">
          <span class="brain-chat-saved-badge">✅ Saved to Brain</span>
        </div>
        <div class="brain-chat-saved-title">${escapeHtml(m.savedTitle || 'Note')}</div>
        ${m.savedSummary ? `<div class="brain-chat-saved-summary">💭 ${escapeHtml(m.savedSummary)}</div>` : ''}
        ${m.savedWhy ? `<div class="brain-chat-saved-why">🎯 <em>${escapeHtml(m.savedWhy)}</em></div>` : ''}
        ${tagsHtml ? `<div class="brain-chat-saved-tags">${tagsHtml}</div>` : ''}
        <a class="brain-chat-saved-link" href="${escapeHtml(m.savedUrl)}" target="_blank" rel="noopener">🔗 Open in Brain →</a>
      `
      el.appendChild(card)
    }
    messagesEl.appendChild(el)
    messagesEl.scrollTop = messagesEl.scrollHeight
  }
  function renderMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[Note (\d+)\]/g, '<sup class="brain-chat-cite">[$1]</sup>')
      .replace(/\n/g, '<br>')
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
  function fmtBytes(n) { if (!n) return ''; if (n < 1024) return n + 'B'; if (n < 1048576) return (n/1024).toFixed(1)+'KB'; return (n/1048576).toFixed(1)+'MB' }
  function iconFor(kind) { return ({ image: '🖼️', pdf: '📕', docx: '📄', text: '📝' })[kind] || '📎' }

  function renderPreview() {
    if (!pendingAttachment) { previewEl.hidden = true; previewEl.innerHTML = ''; return }
    previewEl.hidden = false
    const a = pendingAttachment
    previewEl.innerHTML = `
      ${a.kind === 'image' ? `<img src="${a.dataUrl}" alt=""/>` : `<div class="brain-chat-att-icon">${iconFor(a.kind)}</div>`}
      <div class="brain-chat-att-meta">
        <div class="brain-chat-att-name">${escapeHtml(a.name)}</div>
        <div class="brain-chat-att-sub">${a.kind} · ${fmtBytes(a.size)}${a.text ? ` · ${a.text.length} chars` : ''}</div>
      </div>
      <button type="button" class="brain-chat-att-remove" aria-label="Remove">×</button>
    `
    previewEl.querySelector('.brain-chat-att-remove').addEventListener('click', () => { pendingAttachment = null; renderPreview() })
  }

  function openChat() {
    drawer.classList.add('open'); btn.classList.add('hidden')
    document.documentElement.classList.add('brain-chat-open')
    document.body.classList.add('brain-chat-open')
    localStorage.setItem(K_OPEN, '1')
    // Don't auto-focus on mobile — it pops the keyboard before the user sees the chat
    if (!isTouchDevice()) setTimeout(() => input.focus(), 200)
  }
  function closeChat() {
    drawer.classList.remove('open'); btn.classList.remove('hidden')
    document.documentElement.classList.remove('brain-chat-open')
    document.body.classList.remove('brain-chat-open')
    localStorage.removeItem(K_OPEN)
  }
  function isTouchDevice() { return window.matchMedia('(pointer: coarse)').matches }

  // Keep drawer sized to visualViewport so the soft keyboard doesn't hide the input
  function updateViewportHeight() {
    const h = window.visualViewport?.height || window.innerHeight
    drawer.style.setProperty('--brain-chat-vh', `${h}px`)
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportHeight)
    window.visualViewport.addEventListener('scroll', updateViewportHeight)
  }
  window.addEventListener('resize', updateViewportHeight)
  updateViewportHeight()
  // When the input is focused on mobile, scroll it into view after the keyboard animation
  input.addEventListener('focus', () => {
    if (!isTouchDevice()) return
    setTimeout(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight
      input.scrollIntoView({ block: 'end', behavior: 'smooth' })
    }, 300)
  })
  btn.addEventListener('click', openChat)
  drawer.querySelector('.brain-chat-close').addEventListener('click', closeChat)
  drawer.querySelector('.brain-chat-new').addEventListener('click', () => {
    if (confirm('Start a new chat? Current conversation will be cleared.')) {
      history = []; pendingAttachment = null; saveHistory(); renderAll(); renderPreview()
    }
  })

  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) handleFile(f); fileInput.value = '' })

  ;['dragenter','dragover'].forEach(evt => drawer.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('active') }))
  ;['dragleave','drop'].forEach(evt => drawer.addEventListener(evt, (e) => { e.preventDefault(); if (evt === 'drop' || e.target === drawer) dropzone.classList.remove('active') }))
  drawer.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('active'); const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f) })

  async function handleFile(file) {
    if (file.size > MAX_SIZE) { alert(`File too large (max ${MAX_SIZE/1048576}MB)`); return }
    const kind = detectKind(file)
    if (!kind) { alert('Unsupported file type. Use: image, PDF, DOCX, TXT, or MD.'); return }
    pendingAttachment = { name: file.name, mime: file.type, size: file.size, kind }
    renderPreview()
    try {
      if (kind === 'image') {
        pendingAttachment.dataUrl = await readAsDataURL(file)
      } else if (kind === 'text') {
        pendingAttachment.text = await file.text()
        pendingAttachment.dataUrl = await readAsDataURL(file)
      } else if (kind === 'pdf') {
        setPreviewBusy('Extracting text from PDF…')
        pendingAttachment.dataUrl = await readAsDataURL(file)
        pendingAttachment.text = await extractPdfText(file)
      } else if (kind === 'docx') {
        setPreviewBusy('Extracting text from DOCX…')
        pendingAttachment.dataUrl = await readAsDataURL(file)
        pendingAttachment.text = await extractDocxText(file)
      }
      renderPreview()
    } catch (err) {
      console.error(err)
      alert('Failed to read file: ' + err.message)
      pendingAttachment = null; renderPreview()
    }
  }
  function setPreviewBusy(msg) {
    previewEl.hidden = false
    previewEl.innerHTML = `<div class="brain-chat-att-icon">⏳</div><div class="brain-chat-att-meta"><div class="brain-chat-att-name">${escapeHtml(pendingAttachment.name)}</div><div class="brain-chat-att-sub">${escapeHtml(msg)}</div></div>`
  }

  function detectKind(f) {
    if (f.type.startsWith('image/')) return 'image'
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf'
    if (/\.(docx)$/i.test(f.name) || f.type.includes('wordprocessingml')) return 'docx'
    if (f.type.startsWith('text/') || /\.(txt|md|markdown)$/i.test(f.name)) return 'text'
    return null
  }
  function readAsDataURL(f) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f) }) }

  async function extractPdfText(file) {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs'
    const buf = await file.arrayBuffer()
    const doc = await pdfjs.getDocument({ data: buf }).promise
    const parts = []
    const maxPages = Math.min(doc.numPages, 50)
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      parts.push(content.items.map(it => it.str).join(' '))
    }
    return parts.join('\n\n')
  }
  async function extractDocxText(file) {
    const mammoth = await import('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/+esm')
    const buf = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer: buf })
    return result.value || ''
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = input.value.trim()
    if (!msg && !pendingAttachment) return

    let pass = localStorage.getItem(K_PASS)
    if (!pass) { pass = prompt('Enter your Brain passphrase:'); if (!pass) return; localStorage.setItem(K_PASS, pass) }

    input.value = ''
    const attachmentForSend = pendingAttachment
    const attEcho = attachmentForSend ? { name: attachmentForSend.name, kind: attachmentForSend.kind, size: attachmentForSend.size, mime: attachmentForSend.mime } : null
    history.push({ role: 'user', content: msg || `(attached ${attachmentForSend?.kind})`, attachmentEcho: attEcho })
    pendingAttachment = null; renderPreview(); saveHistory(); renderAll()

    const typing = document.createElement('div')
    typing.className = 'brain-chat-msg brain-chat-msg-assistant'
    typing.innerHTML = `<div class="brain-chat-bubble brain-chat-typing"><span></span><span></span><span></span></div>`
    messagesEl.appendChild(typing)
    messagesEl.scrollTop = messagesEl.scrollHeight

    try {
      const res = await fetch(`${WORKER_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Passphrase': pass },
        body: JSON.stringify({ message: msg, history: history.slice(0, -1).map(h => ({ role: h.role, content: h.content })), attachment: attachmentForSend }),
      })
      typing.remove()
      if (res.status === 401) {
        localStorage.removeItem(K_PASS)
        history.push({ role: 'assistant', content: '❌ Wrong passphrase. Try again.' })
      } else if (!res.ok) {
        history.push({ role: 'assistant', content: `❌ Error ${res.status}. Try again.` })
      } else {
        const data = await res.json()
        const entry = { role: 'assistant', content: data.answer, sources: data.sources || [] }
        if (data.canSave) {
          entry.canSave = true
          entry._pendingAttachment = attachmentForSend
          entry._userMessage = msg
        }
        history.push(entry)
      }
      saveHistory(); renderAll()
    } catch (err) {
      typing.remove()
      history.push({ role: 'assistant', content: `❌ Network error: ${err.message}` })
      saveHistory(); renderAll()
    }
  })

  async function saveToBrain(idx, btnEl) {
    const m = history[idx]
    if (!m || !m._pendingAttachment) { alert('Attachment expired (page reloaded). Re-upload to save.'); return }
    btnEl.disabled = true; btnEl.innerHTML = '⏳ Saving…'
    const pass = localStorage.getItem(K_PASS)
    try {
      const res = await fetch(`${WORKER_URL}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Passphrase': pass },
        body: JSON.stringify({ message: m._userMessage, answer: m.content, attachment: m._pendingAttachment }),
      })
      if (!res.ok) { const e = await res.text(); throw new Error(e) }
      const data = await res.json()
      m.savedUrl = data.noteUrl
      m.savedTitle = data.title
      m.savedSummary = data.summary || ''
      m.savedWhy = data.whySaved || ''
      m.savedTags = data.tags || []
      m.canSave = false
      delete m._pendingAttachment
      saveHistory(); renderAll()
    } catch (err) {
      btnEl.disabled = false; btnEl.innerHTML = '💾 Save to Brain'
      alert('Save failed: ' + err.message)
    }
  }

  renderAll()
  renderPreview()
  if (localStorage.getItem(K_OPEN)) openChat()
})()
