// @ts-ignore
import script from "./scripts/sidebarToggle.inline"
import { QuartzComponent, QuartzComponentConstructor } from "./types"

const SidebarToggle: QuartzComponent = () => {
  return (
    <button id="sidebar-toggle-btn" aria-label="Toggle sidebar">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
  )
}

SidebarToggle.afterDOMLoaded = script

export default (() => SidebarToggle) satisfies QuartzComponentConstructor
