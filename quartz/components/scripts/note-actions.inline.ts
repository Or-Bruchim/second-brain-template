// Note edit/delete widget — talks to the same Worker as BrainChat.
// Reuses LS_PASS so users only enter the passphrase once across both widgets.

const LS_PASS = "brain-chat-pass"
const MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"

let markedLoadPromise: Promise<any> | null = null
function loadMarked(): Promise<any> {
  // @ts-ignore
  if (typeof window !== "undefined" && (window as any).marked) return Promise.resolve((window as any).marked)
  if (markedLoadPromise) return markedLoadPromise
  markedLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = MARKED_CDN
    s.async = true
    s.onload = () => resolve((window as any).marked)
    s.onerror = () => reject(new Error("Failed to load marked"))
    document.head.appendChild(s)
  })
  return markedLoadPromise
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function getPass(): string | null {
  return localStorage.getItem(LS_PASS)
}

function setPass(v: string): void {
  localStorage.setItem(LS_PASS, v)
}

function clearPass(): void {
  localStorage.removeItem(LS_PASS)
}

function setupNoteActions(root: HTMLElement) {
  const workerUrl = root.dataset.workerUrl || ""
  const slug = root.dataset.slug || ""
  if (!workerUrl || !slug) return

  const editBtn = root.querySelector<HTMLButtonElement>(".note-action-edit")!
  const deleteBtn = root.querySelector<HTMLButtonElement>(".note-action-delete")!
  const modal = root.querySelector<HTMLElement>(".note-actions-modal")!
  const closeBtn = root.querySelector<HTMLButtonElement>(".note-actions-modal-close")!
  const cancelBtn = root.querySelector<HTMLButtonElement>(".note-actions-cancel")!
  const saveBtn = root.querySelector<HTMLButtonElement>(".note-actions-save")!
  const textarea = root.querySelector<HTMLTextAreaElement>(".note-actions-textarea")!
  const previewEl = root.querySelector<HTMLElement>(".note-actions-preview")!
  const status = root.querySelector<HTMLElement>(".note-actions-status")!
  const auth = root.querySelector<HTMLElement>(".note-actions-auth")!
  const authInput = root.querySelector<HTMLInputElement>(".note-actions-auth-input")!
  const authSubmit = root.querySelector<HTMLButtonElement>(".note-actions-auth-submit")!
  const authError = root.querySelector<HTMLElement>(".note-actions-auth-error")!
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".note-actions-tab"))
  const body = root.querySelector<HTMLElement>(".note-actions-body")!

  function setStatus(msg: string, kind: "info" | "ok" | "error" = "info") {
    status.textContent = msg
    status.dataset.kind = kind
  }

  function openModal() {
    modal.hidden = false
    document.body.style.overflow = "hidden"
  }

  function closeModal() {
    modal.hidden = true
    document.body.style.overflow = ""
    setStatus("")
  }

  function showAuth(showError = false) {
    auth.hidden = false
    authInput.focus()
    authError.hidden = !showError
    if (showError) authError.textContent = "Wrong passphrase"
  }

  function hideAuth() {
    auth.hidden = true
    authError.hidden = true
  }

  async function ensureAuth(): Promise<string | null> {
    let pass = getPass()
    if (pass) return pass
    return new Promise((resolve) => {
      showAuth(false)
      const submit = () => {
        const v = (authInput.value || "").trim()
        if (!v) return
        setPass(v)
        hideAuth()
        authSubmit.removeEventListener("click", submit)
        authInput.removeEventListener("keydown", onKey)
        resolve(v)
      }
      const onKey = (e: KeyboardEvent) => { if (e.key === "Enter") submit() }
      authSubmit.addEventListener("click", submit)
      authInput.addEventListener("keydown", onKey)
    })
  }

  async function renderPreview() {
    try {
      const marked = await loadMarked()
      const md = textarea.value
      // Strip frontmatter for preview
      const body = md.replace(/^---[\s\S]*?---\n?/, "")
      const html = marked.parse(body, { breaks: true, gfm: true })
      previewEl.innerHTML = html
    } catch (err) {
      previewEl.innerHTML = `<p class="note-actions-error">Preview unavailable: ${escapeHtml(String(err))}</p>`
    }
  }

  function setPane(pane: "split" | "edit" | "preview") {
    body.dataset.pane = pane
    tabs.forEach(t => t.classList.toggle("is-active", t.dataset.pane === pane))
  }

  async function loadNote() {
    const pass = await ensureAuth()
    if (!pass) return
    setStatus("Loading…")
    textarea.value = ""
    previewEl.innerHTML = ""
    try {
      const res = await fetch(`${workerUrl}/note?slug=${encodeURIComponent(slug)}`, {
        headers: { "X-Chat-Passphrase": pass },
      })
      if (res.status === 401) {
        clearPass()
        showAuth(true)
        return
      }
      if (!res.ok) {
        setStatus(`Failed to load (${res.status})`, "error")
        return
      }
      const data = await res.json()
      textarea.value = data.content || ""
      setStatus("")
      await renderPreview()
    } catch (err) {
      setStatus(`Error: ${err}`, "error")
    }
  }

  async function saveNote() {
    const pass = await ensureAuth()
    if (!pass) return
    saveBtn.disabled = true
    setStatus("Saving…")
    try {
      const res = await fetch(`${workerUrl}/note/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Chat-Passphrase": pass },
        body: JSON.stringify({ slug, content: textarea.value }),
      })
      if (res.status === 401) {
        clearPass()
        showAuth(true)
        saveBtn.disabled = false
        return
      }
      if (!res.ok) {
        const err = await res.text().catch(() => `${res.status}`)
        setStatus(`Save failed: ${err}`, "error")
        saveBtn.disabled = false
        return
      }
      setStatus("Saved · site rebuilds in ~1 min", "ok")
      saveBtn.disabled = false
      setTimeout(() => closeModal(), 1500)
    } catch (err) {
      setStatus(`Error: ${err}`, "error")
      saveBtn.disabled = false
    }
  }

  async function deleteNote() {
    const ok = window.confirm(`Delete this note?\n\n${slug}\n\nThis can't be undone.`)
    if (!ok) return
    let pass = getPass()
    if (!pass) {
      const input = window.prompt("Enter passphrase to delete:")
      if (!input) return
      pass = input.trim()
      if (pass) setPass(pass)
    }
    if (!pass) return
    deleteBtn.disabled = true
    console.log("[delete] starting delete for slug:", slug)
    console.log("[delete] worker url:", workerUrl)
    try {
      const res = await fetch(`${workerUrl}/note/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Chat-Passphrase": pass },
        body: JSON.stringify({ slug }),
      })
      console.log("[delete] response status:", res.status)
      if (res.status === 401) {
        clearPass()
        deleteBtn.disabled = false
        alert("Wrong passphrase — please try again.")
        return
      }
      const data = await res.json().catch(() => null)
      console.log("[delete] response body:", JSON.stringify(data))
      if (!res.ok) {
        alert(`Delete failed (${res.status}): ${data?.error ?? "unknown error"}`)
        deleteBtn.disabled = false
        return
      }
      if (!data?.noteDeleted) {
        alert(`Note not found on GitHub (slug: ${slug})\n\nMight already be deleted, or the slug path is wrong.\n\nCheck DevTools console for details.`)
        deleteBtn.disabled = false
        return
      }
      const attachMsg = data.attachmentsDeleted > 0 ? ` + ${data.attachmentsDeleted} attachment(s)` : ""
      alert(`✅ Deleted${attachMsg}. Site rebuilds in ~1 min.`)
      const depth = slug.split("/").length
      window.location.href = "../".repeat(depth) || "./"
    } catch (err) {
      console.error("[delete] fetch error:", err)
      alert(`Network error: ${err}`)
      deleteBtn.disabled = false
    }
  }

  // Wire up
  editBtn.addEventListener("click", async () => {
    openModal()
    setPane("split")
    await loadNote()
  })
  deleteBtn.addEventListener("click", deleteNote)
  closeBtn.addEventListener("click", closeModal)
  cancelBtn.addEventListener("click", closeModal)
  modal.querySelector(".note-actions-modal-backdrop")?.addEventListener("click", closeModal)
  saveBtn.addEventListener("click", saveNote)
  tabs.forEach(t => t.addEventListener("click", () => setPane(t.dataset.pane as any)))

  // Live preview, debounced
  let timer: any = null
  textarea.addEventListener("input", () => {
    clearTimeout(timer)
    timer = setTimeout(renderPreview, 200)
  })

  // Esc closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal()
  })
}

document.addEventListener("nav", () => {
  const root = document.querySelector<HTMLElement>(".note-actions-root")
  if (root) setupNoteActions(root)
})
