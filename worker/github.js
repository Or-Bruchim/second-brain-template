import { GIT_IDENTITY } from "./constants.js"
import { deleteChunksByNote } from "./retrieve.js"
import { decodeGithubContent } from "./util.js"

export async function deleteGithubFile(path, env) {
  const branch = env.GITHUB_BRANCH || 'v4'
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' }
  const checkUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${branch}`
  const check = await fetch(checkUrl, { headers })
  if (!check.ok) return false
  const { sha } = await check.json()
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `delete: ${path}`, sha, branch, committer: GIT_IDENTITY, author: GIT_IDENTITY }),
  })
  return res.ok
}

export async function deleteNote(slug, env) {
  // Support prefixed slugs: "journal/...", "inbox/...", "recipes/..." or bare slug
  const isJournal = slug.startsWith('journal/')
  const isRecipe = slug.startsWith('recipes/')
  const cleanSlug = slug.replace(/^(inbox|journal|recipes)\//, '')
  const folder = isJournal ? 'journal' : isRecipe ? 'recipes' : 'inbox'

  // Remove the note's chunks from Supabase so it drops out of search at once.
  await deleteChunksByNote(`${folder}/${cleanSlug}`, env)

  // GitHub: delete the .md note + any known attachment patterns
  const candidates = [
    `content/${folder}/${cleanSlug}.md`,
    `content/attachments/${cleanSlug}.jpg`,
    `content/attachments/${cleanSlug}.png`,
    `content/attachments/${cleanSlug}.webp`,
    `content/attachments/${cleanSlug}.mp4`,
    `content/attachments/${cleanSlug}-thumb.jpg`,
    `content/attachments/${cleanSlug}-thumb.png`,
    `content/attachments/${cleanSlug}-thumb.webp`,
    `content/attachments/${cleanSlug}-transcript.txt`,
  ]
  const results = await Promise.allSettled(candidates.map(p => deleteGithubFile(p, env)))
  const deleted = results.filter(r => r.status === 'fulfilled' && r.value).length

  await triggerDeploy(env)
  return { deleted, mainFound: results[0].status === 'fulfilled' && results[0].value }
}

export async function commitFile(path, content, message, env, isBuffer = false, isNew = false) {
  const branch = env.GITHUB_BRANCH || 'v4'
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`
  const bytes = isBuffer ? new Uint8Array(content) : new TextEncoder().encode(content)
  let binary = ''; for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  const base64Content = btoa(binary)
  let sha
  if (!isNew) {
    try {
      const check = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } })
      if (check.ok) sha = (await check.json()).sha
    } catch {}
  }
  const body = { message, content: base64Content, branch, committer: GIT_IDENTITY, author: GIT_IDENTITY }
  if (sha) body.sha = sha
  let res = await fetch(apiUrl, { method: 'PUT', headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'OrBrainBot' }, body: JSON.stringify(body) })
  // If the file already existed (rare for timestamp slugs but possible on retry), fall back to the SHA path
  if (!res.ok && isNew && (res.status === 422 || res.status === 409)) {
    try {
      const check = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' } })
      if (check.ok) {
        const existing = await check.json()
        body.sha = existing.sha
        res = await fetch(apiUrl, { method: 'PUT', headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'OrBrainBot' }, body: JSON.stringify(body) })
      }
    } catch {}
  }
  if (!res.ok) throw new Error(`GitHub commit failed (${res.status}) for ${path}: ${await res.text()}`)
}

// ── Weekly review ──────────────────────────────────────────────────────
// Fetch a repo file's raw markdown via the GitHub contents API. Returns '' on failure.
export async function fetchRepoFile(path, env) {
  try {
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH || 'v4'}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'OrBrainBot' },
    })
    if (!res.ok) return ''
    const data = await res.json()
    return decodeGithubContent(data.content) || ''
  } catch {
    return ''
  }
}

export async function triggerDeploy(env) {
  try {
    const branch = env.GITHUB_BRANCH || 'v4'
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/deploy.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'OrBrainBot' },
      body: JSON.stringify({ ref: branch }),
    })
    if (!res.ok) console.error('triggerDeploy failed:', res.status, await res.text())
  } catch (err) {
    console.error('triggerDeploy error:', err)
  }
}
