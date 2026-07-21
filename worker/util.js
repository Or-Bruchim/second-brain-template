import { CORS_HEADERS } from "./constants.js"
import { sendTelegram } from "./telegram.js"

export const DEFAULT_PHONE_COUNTRY_CODE = '972'

export function normalizePhone(raw) {
  const hasPlus = /^\s*\+/.test(raw)
  const digits = raw.replace(/\D/g, '')
  if (hasPlus) return digits
  if (digits.startsWith('00')) return digits.slice(2)
  if (digits.startsWith('0')) return DEFAULT_PHONE_COUNTRY_CODE + digits.slice(1)
  return digits
}

export function extractPhoneNumbers(text) {
  if (!text) return []
  const matches = text.match(/\+?[\d][\d\s().\-]{7,}\d/g) || []
  const seen = new Set()
  const out = []
  for (const m of matches) {
    const digitsOnly = m.replace(/\D/g, '')
    if (digitsOnly.length < 9 || digitsOnly.length > 15) continue
    const startsInternational = /^\s*(\+|00)/.test(m)
    if (!startsInternational && !digitsOnly.startsWith('0') && !digitsOnly.startsWith(DEFAULT_PHONE_COUNTRY_CODE)) continue
    const norm = normalizePhone(m)
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

// True (returns the numbers) when the message is essentially just phone number(s),
// so we reply with a WhatsApp chat link instead of saving it as a note.
export function looksLikePhoneMessage(text) {
  const nums = extractPhoneNumbers(text)
  if (nums.length === 0) return null
  const remainder = (text || '').replace(/\+?[\d][\d\s().\-]{7,}\d/g, '').replace(/[\s,;.:׳״]/g, '').trim()
  if (remainder.length > 15) return null
  return nums
}

export async function handlePhoneNumber(message, numbers, env) {
  const body = numbers.length === 1
    ? `💬 שיחת וואטסאפ עם +${numbers[0]}:\nhttps://wa.me/${numbers[0]}`
    : `💬 שיחות וואטסאפ:\n` + numbers.map((n) => `+${n} — https://wa.me/${n}`).join('\n')
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, message.chat.id, body)
}

export function sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return null
  // Disallow path traversal and absolute paths; allow letters/digits/dash/underscore/slash/dot
  if (slug.includes('..') || slug.startsWith('/') || /[^a-zA-Z0-9._\-/]/.test(slug)) return null
  return slug.replace(/^\/+/, '').replace(/\/+$/, '')
}

export function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function tokenize(text) {
  const stopwords = new Set([
    // English
    'the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','by',
    'what','when','where','who','how','why','i','me','my','you','your','it','this','that','these','those',
    'about','do','does','did','can','could','would','should','have','has','had','be','been',
    // Hebrew
    'של','את','על','עם','לא','כי','אם','אל','כן','יש','הוא','היא','הם','הן','אנחנו','אני',
    'אתה','זה','זו','אלה','מה','מי','איך','למה','כך','כבר','רק','גם','עוד','אחרי','לפני',
    'כל','בין','אבל','או','מן','בו','בה','בם','בן','לו','לה','שהוא','שהיא','שהם',
  ])
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stopwords.has(t))
  )]
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } })
}

export function simpleHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// Decode base64 GitHub content as UTF-8 text (atob gives Latin-1 bytes, not Unicode)
export function decodeGithubContent(b64) {
  const raw = atob(b64.replace(/\s/g, ''))
  return new TextDecoder('utf-8').decode(Uint8Array.from(raw, c => c.charCodeAt(0)))
}

// Encode UTF-8 text to base64 for GitHub API
export function encodeGithubContent(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + CHUNK, arr.length)))
  }
  return btoa(binary)
}

export function escapeHtmlTg(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}