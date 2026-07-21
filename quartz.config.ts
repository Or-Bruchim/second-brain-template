import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

const config: QuartzConfig = {
  configuration: {
    pageTitle: "🧠 My Second Brain", // TODO: rename to your own brain
    pageTitleSuffix: " | My Second Brain", // TODO: rename to your own brain
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "en-US",
    baseUrl: "your-project.pages.dev", // TODO: replace with your Cloudflare Pages URL once deployed
    ignorePatterns: ["private", "templates", ".obsidian", "worker"],
    defaultDateType: "created",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Urbanist",
        body: "Assistant",
        code: "IBM Plex Mono",
      },
      colors: {
        lightMode: {
          light: "#f8fafc",
          lightgray: "#f1f5f9",
          gray: "#94a3b8",
          darkgray: "#334155",
          dark: "#201f87",
          secondary: "#355872",
          tertiary: "#7AAACE",
          highlight: "rgba(32,31,135,0.08)",
          textHighlight: "rgba(122,170,206,0.30)",
        },
        darkMode: {
          light: "#0f172a",
          lightgray: "#1e293b",
          gray: "#475569",
          darkgray: "#cbd5e1",
          dark: "#f1f5f9",
          secondary: "#7AAACE",
          tertiary: "#355872",
          highlight: "rgba(122,170,206,0.10)",
          textHighlight: "rgba(122,170,206,0.20)",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: { light: "github-light", dark: "github-dark" },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
