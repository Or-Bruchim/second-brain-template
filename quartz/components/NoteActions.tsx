import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/note-actions.inline"
// @ts-ignore
import styles from "./styles/noteActions.scss"

type Options = {
  workerUrl?: string
}

const defaultOpts: Options = {
  workerUrl: "",
}

export default ((userOpts?: Options) => {
  const opts = { ...defaultOpts, ...userOpts }

  const NoteActions: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
    const slug = fileData.slug ?? ""
    // Hide on system pages (tag pages, 404, index, folder indexes)
    if (!slug || slug === "index" || slug === "404" || slug.startsWith("tags/")) {
      return null
    }

    return (
      <div
        class={`note-actions-root ${displayClass ?? ""}`}
        data-worker-url={opts.workerUrl}
        data-slug={slug}
      >
        <div class="note-actions-bar">
          <button class="note-action note-action-edit" title="Edit note" aria-label="Edit note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
            <span>Edit</span>
          </button>
          <button class="note-action note-action-delete" title="Delete note" aria-label="Delete note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
            <span>Delete</span>
          </button>
        </div>

        <div class="note-actions-modal" hidden>
          <div class="note-actions-modal-backdrop"></div>
          <div class="note-actions-modal-panel">
            <div class="note-actions-modal-header">
              <div class="note-actions-modal-title">Edit note</div>
              <div class="note-actions-modal-actions">
                <button class="note-actions-tab is-active" data-pane="split" type="button">Split</button>
                <button class="note-actions-tab" data-pane="edit" type="button">Edit</button>
                <button class="note-actions-tab" data-pane="preview" type="button">Preview</button>
                <button class="note-actions-modal-close" type="button" aria-label="Close">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            <div class="note-actions-auth" hidden>
              <p class="note-actions-auth-msg">🔒 Enter passphrase to edit</p>
              <input type="password" class="note-actions-auth-input" placeholder="Passphrase" />
              <button class="note-actions-auth-submit" type="button">Unlock</button>
              <p class="note-actions-auth-error" hidden></p>
            </div>

            <div class="note-actions-body">
              <div class="note-actions-pane note-actions-pane-edit">
                <textarea class="note-actions-textarea" spellcheck={false} placeholder="Loading…"></textarea>
              </div>
              <div class="note-actions-pane note-actions-pane-preview">
                <div class="note-actions-preview"></div>
              </div>
            </div>

            <div class="note-actions-modal-footer">
              <span class="note-actions-status"></span>
              <div class="note-actions-modal-buttons">
                <button class="note-actions-btn note-actions-cancel" type="button">Cancel</button>
                <button class="note-actions-btn note-actions-save is-primary" type="button">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  NoteActions.afterDOMLoaded = script
  NoteActions.css = styles

  return NoteActions
}) satisfies QuartzComponentConstructor<Options>
