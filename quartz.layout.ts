import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import SidebarToggle from "./quartz/components/SidebarToggle"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [
    Component.BrainChat({
      // Override at build time via BRAIN_WORKER_URL; fallback is the prod Worker.
      workerUrl: process.env.BRAIN_WORKER_URL || "https://your-worker.your-subdomain.workers.dev",
    }),
  ],
  footer: Component.Footer({
    links: {
      GitHub: "https://github.com/jackyzha0/quartz",
      "Discord Community": "https://discord.gg/cRFFHYye7t",
    },
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
    Component.NoteActions({
      workerUrl: process.env.BRAIN_WORKER_URL || "https://your-worker.your-subdomain.workers.dev",
    }),
  ],
  left: [
    SidebarToggle(),
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.Graph({
      localGraph: {
        depth: 2,
        linkDistance: 55,
        fontSize: 0.7,
        repelForce: 0.7,
        centerForce: 0.25,
        focusOnHover: true,
        // local graph shows real wikilink neighbors only — tags pull in
        // half the wiki at depth 2 and drown the page's actual context
        showTags: false,
        // raw layer + auto-maintained hub pages drown out the real note links
        removeSlugs: ["inbox/", "journal/", "memory/", "catalog", "log", "activity", "overview"],
      },
      globalGraph: {
        linkDistance: 50,
        fontSize: 0.65,
        repelForce: 0.45,
        centerForce: 0.2,
        focusOnHover: true,
        // domain tags (#ai, #design...) cluster the global view; type and
        // plumbing tags connect everything to everything — hide those
        removeTags: [
          "note", "meta", "concept", "tool", "person", "journal", "neutral",
          "telegram", "inbox", "link", "chat", "image", "video", "capture",
          "synthesis", "manual", "instagram", "facebook",
        ],
        // journal/memory are diary-style pages with sentence-long titles —
        // they clutter the knowledge view and rarely link to notes
        removeSlugs: ["inbox/", "journal/", "memory/", "catalog", "log", "activity", "overview"],
      },
    }),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
