// Brain Chat — floating widget that talks to the Cloudflare Worker.
// Auth: passphrase is never stored — exchanged for a 24h session token kept in sessionStorage.
// History: stored in localStorage (survives browser restarts, not sensitive).

const LS_TOKEN = "brain-chat-token"   // sessionStorage — cleared when browser closes
const LS_SESSION = "brain-chat-session"
const LS_HISTORY = "brain-chat-history"

type Msg = { role: "user" | "assistant"; content: string; sources?: { title: string; url: string }[] }

function getOrCreateSessionId(): string {
  let id = sessionStorage.getItem(LS_SESSION)
  if (!id) {
    id = (crypto.randomUUID?.() || `s-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionStorage.setItem(LS_SESSION, id)
  }
  return id
}

function saveHistoryLocal(history: Msg[]) {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(-20))) } catch {}
}

function loadHistoryLocal(): Msg[] {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]") } catch { return [] }
}

function clearHistoryLocal() {
  localStorage.removeItem(LS_HISTORY)
  sessionStorage.removeItem(LS_SESSION)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c))
}

// Lightweight markdown: paragraphs, bold, italic, code, links
function renderMarkdown(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>")
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  html = html.replace(/\n\n/g, "</p><p>")
  html = html.replace(/\n/g, "<br>")
  return `<p>${html}</p>`
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsText(file)
  })
}

function detectKind(file: File): "image" | "video" | "pdf" | "text" | "file" {
  if (file.type.startsWith("image/")) return "image"
  if (file.type.startsWith("video/")) return "video"
  if (file.type === "application/pdf") return "pdf"
  if (file.type.startsWith("text/") || file.name.match(/\.(md|txt|json|csv|tsv)$/i)) return "text"
  return "file"
}

let pendingAttachment: any = null

function init() {
  const root = document.querySelector<HTMLElement>(".brain-chat-root")
  if (!root) return
  const workerUrl = root.dataset.workerUrl || ""
  if (!workerUrl) {
    console.warn("BrainChat: no worker URL configured")
    return
  }

  const fab = root.querySelector<HTMLButtonElement>(".brain-chat-fab")!
  const panel = root.querySelector<HTMLElement>(".brain-chat-panel")!
  const closeBtn = root.querySelector<HTMLButtonElement>(".brain-chat-close")!
  const clearBtn = root.querySelector<HTMLButtonElement>(".brain-chat-clear")!
  const messagesEl = root.querySelector<HTMLElement>(".brain-chat-messages")!
  const form = root.querySelector<HTMLFormElement>(".brain-chat-input-row")!
  const input = root.querySelector<HTMLTextAreaElement>(".brain-chat-input")!
  const sendBtn = root.querySelector<HTMLButtonElement>(".brain-chat-send")!
  const attachBtn = root.querySelector<HTMLButtonElement>(".brain-chat-attach")!
  const fileInput = root.querySelector<HTMLInputElement>(".brain-chat-file")!
  const previewEl = root.querySelector<HTMLElement>(".brain-chat-attachment-preview")!
  const authEl = root.querySelector<HTMLElement>(".brain-chat-auth")!
  const authInput = root.querySelector<HTMLInputElement>(".brain-chat-auth-input")!
  const authSubmit = root.querySelector<HTMLButtonElement>(".brain-chat-auth-submit")!
  const authError = root.querySelector<HTMLElement>(".brain-chat-auth-error")!
  const quickBtns = root.querySelectorAll<HTMLButtonElement>(".brain-chat-quick-btn")

  let history: Msg[] = loadHistoryLocal()
  renderHistory()

  function getToken(): string | null {
    return sessionStorage.getItem(LS_TOKEN)
  }

  function showAuth(showError = false) {
    authEl.hidden = false
    authError.hidden = !showError
    if (showError) authError.textContent = "Wrong passphrase, try again"
    authInput.focus()
  }

  function hideAuth() {
    authEl.hidden = true
  }

  function openPanel() {
    panel.hidden = false
    fab.style.display = "none"
    if (!getToken()) showAuth()
    else input.focus()
  }

  function closePanel() {
    panel.hidden = true
    fab.style.display = ""
  }

  function renderHistory() {
    if (history.length === 0) {
      const empty = messagesEl.querySelector(".brain-chat-empty")
      if (empty) (empty as HTMLElement).hidden = false
      return
    }
    const empty = messagesEl.querySelector(".brain-chat-empty")
    if (empty) (empty as HTMLElement).hidden = true
    // Clear except empty placeholder
    messagesEl.querySelectorAll(".brain-chat-msg").forEach(n => n.remove())
    for (const m of history) appendMessage(m, false)
  }

  function appendMessage(msg: Msg, persist = true) {
    const empty = messagesEl.querySelector(".brain-chat-empty")
    if (empty) (empty as HTMLElement).hidden = true

    const div = document.createElement("div")
    div.className = `brain-chat-msg brain-chat-msg-${msg.role}`
    div.innerHTML = `<div class="brain-chat-bubble">${renderMarkdown(msg.content)}</div>`
    if (msg.sources?.length) {
      const src = document.createElement("div")
      src.className = "brain-chat-sources"
      src.innerHTML = "<span>Sources:</span> " + msg.sources.slice(0, 3).map(
        s => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`
      ).join(" · ")
      div.appendChild(src)
    }
    messagesEl.appendChild(div)
    messagesEl.scrollTop = messagesEl.scrollHeight
    if (persist) {
      history.push(msg)
      saveHistoryLocal(history)
    }
  }

  function appendThinking(): HTMLElement {
    const div = document.createElement("div")
    div.className = "brain-chat-msg brain-chat-msg-assistant brain-chat-thinking"
    div.innerHTML = `<div class="brain-chat-bubble"><span class="brain-chat-typing"><span></span><span></span><span></span></span></div>`
    messagesEl.appendChild(div)
    messagesEl.scrollTop = messagesEl.scrollHeight
    return div
  }

  async function sendMessage(text: string) {
    const token = getToken()
    if (!token) { showAuth(); return }

    const userMsg: Msg = { role: "user", content: text || (pendingAttachment ? `📎 ${pendingAttachment.name}` : "") }
    appendMessage(userMsg)
    input.value = ""
    input.style.height = "auto"
    sendBtn.disabled = true

    const thinking = appendThinking()
    const sentAttachment = pendingAttachment
    pendingAttachment = null
    previewEl.hidden = true
    previewEl.innerHTML = ""

    try {
      const res = await fetch(`${workerUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Chat-Token": token },
        body: JSON.stringify({
          message: text,
          history: history.slice(-6).map(h => ({ role: h.role, content: h.content })),
          attachment: sentAttachment,
          sessionId: getOrCreateSessionId(),
        }),
      })
      thinking.remove()
      if (res.status === 401) {
        sessionStorage.removeItem(LS_TOKEN)
        showAuth(true)
        sendBtn.disabled = false
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const assistantMsg: Msg = { role: "assistant", content: data.answer || "(no answer)", sources: data.sources || [] }
      appendMessage(assistantMsg)

      // Always offer "Save synthesis" for substantive answers.
      // Files content/notes/synthesis/YYYY-MM-DD-{slug}.md so the answer
      // compounds into the wiki layer instead of vanishing into chat history.
      if (data.answer && data.answer.length > 80) {
        const synthBtn = document.createElement("button")
        synthBtn.className = "brain-chat-save-btn brain-chat-synth-btn"
        synthBtn.textContent = "✨ Save synthesis"
        synthBtn.title = "File this answer as a synthesis page in your wiki"
        synthBtn.onclick = async () => {
          synthBtn.disabled = true
          synthBtn.textContent = "Saving…"
          try {
            const sres = await fetch(`${workerUrl}/synthesis/save`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Chat-Token": token },
              body: JSON.stringify({
                question: text,
                answer: data.answer,
                sources: data.sources || [],
              }),
            })
            const sd = await sres.json()
            if (sd.noteUrl) {
              synthBtn.textContent = "✅ Saved to wiki"
              const link = document.createElement("a")
              link.href = sd.noteUrl
              link.target = "_blank"
              link.rel = "noopener"
              link.textContent = " · Open"
              link.className = "brain-chat-save-link"
              synthBtn.after(link)
            } else {
              synthBtn.textContent = "❌ Failed"
              synthBtn.disabled = false
            }
          } catch {
            synthBtn.textContent = "❌ Failed"
            synthBtn.disabled = false
          }
        }
        const lastMsg = messagesEl.querySelector(".brain-chat-msg-assistant:last-child")
        if (lastMsg) lastMsg.appendChild(synthBtn)
      }

      // If save-able (intent SAVE or attachment), show inline save prompt
      if (data.canSave) {
        const saveBtn = document.createElement("button")
        saveBtn.className = "brain-chat-save-btn"
        saveBtn.textContent = "💾 Save to Brain"
        saveBtn.onclick = async () => {
          saveBtn.disabled = true
          saveBtn.textContent = "Saving…"
          try {
            const sres = await fetch(`${workerUrl}/save`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Chat-Token": token },
              body: JSON.stringify({
                message: text,
                answer: data.answer,
                attachment: sentAttachment,
                videoAnalysis: data.videoAnalysis,
              }),
            })
            const sd = await sres.json()
            if (sd.noteUrl) {
              saveBtn.textContent = "✅ Saved"
              const link = document.createElement("a")
              link.href = sd.noteUrl
              link.target = "_blank"
              link.rel = "noopener"
              link.textContent = " · Open"
              link.className = "brain-chat-save-link"
              saveBtn.after(link)
            } else {
              saveBtn.textContent = "❌ Failed"
              saveBtn.disabled = false
            }
          } catch (e) {
            saveBtn.textContent = "❌ Failed"
            saveBtn.disabled = false
          }
        }
        const lastMsg = messagesEl.querySelector(".brain-chat-msg-assistant:last-child")
        if (lastMsg) lastMsg.appendChild(saveBtn)
      }
    } catch (err) {
      thinking.remove()
      appendMessage({ role: "assistant", content: `❌ Error: ${(err as Error).message}` })
    } finally {
      sendBtn.disabled = false
      input.focus()
    }
  }

  // Event wiring
  fab.addEventListener("click", openPanel)
  closeBtn.addEventListener("click", closePanel)

  clearBtn.addEventListener("click", () => {
    if (!confirm("Start a new conversation? Current chat history will be cleared.")) return
    history = []
    clearHistoryLocal()
    messagesEl.querySelectorAll(".brain-chat-msg").forEach(n => n.remove())
    const empty = messagesEl.querySelector(".brain-chat-empty")
    if (empty) (empty as HTMLElement).hidden = false
  })

  authSubmit.addEventListener("click", async () => {
    const v = authInput.value.trim()
    if (!v) return
    authSubmit.disabled = true
    try {
      const res = await fetch(`${workerUrl}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: v }),
      })
      if (res.ok) {
        const { token } = await res.json()
        sessionStorage.setItem(LS_TOKEN, token)
        authInput.value = ""
        hideAuth()
        input.focus()
      } else {
        authError.hidden = false
        authError.textContent = "Wrong passphrase, try again"
        authInput.select()
      }
    } catch {
      authError.hidden = false
      authError.textContent = "Connection error, try again"
    } finally {
      authSubmit.disabled = false
    }
  })
  authInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); authSubmit.click() }
  })

  form.addEventListener("submit", e => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text && !pendingAttachment) return
    sendMessage(text)
  })

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      form.dispatchEvent(new Event("submit", { cancelable: true }))
    }
  })

  input.addEventListener("input", () => {
    input.style.height = "auto"
    input.style.height = Math.min(input.scrollHeight, 160) + "px"
  })

  attachBtn.addEventListener("click", () => fileInput.click())

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const kind = detectKind(file)
    const att: any = { name: file.name, mime: file.type, size: file.size, kind }

    if (kind === "image" || kind === "video") {
      att.dataUrl = await fileToDataUrl(file)
    } else if (kind === "text") {
      att.text = await fileToText(file)
    } else if (kind === "pdf") {
      att.dataUrl = await fileToDataUrl(file)
    } else {
      att.dataUrl = await fileToDataUrl(file)
    }
    pendingAttachment = att
    previewEl.hidden = false
    previewEl.innerHTML = `<span class="brain-chat-attachment-name">📎 ${escapeHtml(file.name)}</span><button class="brain-chat-attachment-remove" aria-label="Remove">✕</button>`
    previewEl.querySelector(".brain-chat-attachment-remove")?.addEventListener("click", () => {
      pendingAttachment = null
      previewEl.hidden = true
      previewEl.innerHTML = ""
      fileInput.value = ""
    })
    fileInput.value = ""
  })

  quickBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const prompt = btn.dataset.prompt || ""
      if (prompt) sendMessage(prompt)
    })
  })

  // Cmd+K / Ctrl+K to open chat
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
      e.preventDefault()
      panel.hidden ? openPanel() : closePanel()
    }
  })
}

document.addEventListener("nav", init)
if (document.readyState !== "loading") init()
else document.addEventListener("DOMContentLoaded", init)
