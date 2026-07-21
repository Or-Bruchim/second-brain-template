/**
 * Second Brain — AI-Powered Telegram + Web Chat → GitHub Knowledge Base
 * v2: /ask command, query expansion, Hebrew tokenizer, race-condition fix
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Chat-Passphrase, X-Chat-Token',
  'Access-Control-Max-Age': '86400',
}

export const SESSION_TTL_SECONDS = 86400 // 24 hours
// TODO: replace with your own name/email — used as the git author for automated commits
export const GIT_IDENTITY = { name: 'Your Name', email: 'you@example.com' }