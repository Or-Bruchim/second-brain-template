import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/brain-chat.inline"
// @ts-ignore
import styles from "./styles/brainChat.scss"

type Options = {
  workerUrl?: string
}

const defaultOpts: Options = {
  workerUrl: "",
}

export default ((userOpts?: Options) => {
  const opts = { ...defaultOpts, ...userOpts }

  const BrainChat: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    return (
      <div class={`brain-chat-root ${displayClass ?? ""}`} data-worker-url={opts.workerUrl}>
        <button
          class="brain-chat-fab"
          aria-label="Open Brain Chat"
          title="Chat with your Brain"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="brain-chat-fab-label">Brain</span>
        </button>

        <div class="brain-chat-panel" hidden>
          <div class="brain-chat-header">
            <div class="brain-chat-title">
              <span class="brain-chat-dot" />
              Second Brain
            </div>
            <div class="brain-chat-actions">
              <button class="brain-chat-icon-btn brain-chat-clear" title="New conversation" aria-label="New conversation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
                </svg>
              </button>
              <button class="brain-chat-icon-btn brain-chat-close" title="Close" aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <div class="brain-chat-auth" hidden>
            <p class="brain-chat-auth-msg">🔒 Enter passphrase to chat with your Brain</p>
            <input type="password" class="brain-chat-auth-input" placeholder="Passphrase" />
            <button class="brain-chat-auth-submit">Unlock</button>
            <p class="brain-chat-auth-error" hidden></p>
          </div>

          <div class="brain-chat-messages" role="log" aria-live="polite">
            <div class="brain-chat-empty">
              <p>Hi 👋 I have access to your notes. Ask, save, or just chat.</p>
              <div class="brain-chat-quick">
                <button class="brain-chat-quick-btn" data-prompt="What did I save this week?">📅 This week</button>
                <button class="brain-chat-quick-btn" data-prompt="Summarize my recent notes">🧠 Summarize</button>
                <button class="brain-chat-quick-btn" data-prompt="What are the open decisions?">⚖️ Decisions</button>
              </div>
            </div>
          </div>

          <form class="brain-chat-input-row">
            <button type="button" class="brain-chat-attach" title="Attach file" aria-label="Attach file">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input type="file" class="brain-chat-file" hidden accept="image/*,video/*,application/pdf,text/*,.md,.txt" />
            <textarea class="brain-chat-input" placeholder="Ask, save, or chat…" rows={1}></textarea>
            <button type="submit" class="brain-chat-send" aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>

          <div class="brain-chat-attachment-preview" hidden></div>
        </div>
      </div>
    )
  }

  BrainChat.afterDOMLoaded = script
  BrainChat.css = styles

  return BrainChat
}) satisfies QuartzComponentConstructor<Options>
