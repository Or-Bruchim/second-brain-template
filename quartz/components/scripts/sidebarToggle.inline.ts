document.addEventListener("nav", () => {
  const HIDDEN_KEY = "sidebar-hidden"

  // Restore persisted state immediately
  if (localStorage.getItem(HIDDEN_KEY) === "1") {
    document.body.classList.add("sidebar-hidden")
  } else {
    document.body.classList.remove("sidebar-hidden")
  }

  // Inject floating re-open tab once
  if (!document.getElementById("sidebar-open-tab")) {
    const tab = document.createElement("button")
    tab.id = "sidebar-open-tab"
    tab.setAttribute("aria-label", "Show sidebar")
    tab.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
    tab.addEventListener("click", () => {
      document.body.classList.remove("sidebar-hidden")
      localStorage.removeItem(HIDDEN_KEY)
    })
    document.body.appendChild(tab)
  }

  const btn = document.getElementById("sidebar-toggle-btn")
  if (!btn) return

  const toggle = () => {
    const nowHidden = document.body.classList.toggle("sidebar-hidden")
    localStorage.setItem(HIDDEN_KEY, nowHidden ? "1" : "0")
    if (!nowHidden) localStorage.removeItem(HIDDEN_KEY)
  }

  btn.addEventListener("click", toggle)
  window.addCleanup(() => btn.removeEventListener("click", toggle))
})
