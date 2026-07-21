import { handleJournalEntry, handleTelegramQuery } from "./handlers.js"

// ── Unified intent router ─────────────────────────────────────────────
// Returns one of: QUERY, JOURNAL, RECIPE, REMINDER, WEB_SEARCH, IMAGE_GEN, SAVE, SKIP, ASK
// Single source of truth for message classification. Replaces the prior
// chain of isJournalIntent/isRecipeIntent/isQuestion/aiDetectJournal/aiDetectRecipe/classifyIntent.

export const INTENT_LABELS = ['QUERY', 'JOURNAL', 'RECIPE', 'REMINDER', 'WEB_SEARCH', 'IMAGE_GEN', 'CALENDAR', 'META', 'SAVE', 'SKIP', 'ASK']

// Trivial fast-path — regex only, no LLM. Returns intent string or null.
export function fastPathIntent(text, hasMedia, hasUrl) {
  const t = (text || '').trim()

  // Bare media / bare URL with no text → SAVE (no need for LLM)
  if (!t && (hasMedia || hasUrl)) return 'SAVE'

  if (!t) return 'SKIP'

  const lower = t.toLowerCase()

  // Trivial chit-chat — skip
  const trivial = [
    /^(שלום|היי|אהלן|הי|הלו|מה נשמע|מה קורה|מה המצב)[.! ]*$/,
    /^(תודה|תודה רבה|תודה לך|סבבה|אוקיי|אוקי|בסדר|יופי|מעולה|אחלה|נחמד|נהדר|כן|לא|אולי)[.! ]*$/,
    /^(hi|hey|hello|sup|yo|ok|okay|cool|nice|thanks|thank you|lol|haha|yes|no|sure|alright)[.! ]*$/i,
    /^(test|בדיקה|check)[.! ]*$/i,
    /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]{1,5}$/u,  // 1-5 emojis only
  ]
  if (trivial.some(p => p.test(t))) return 'SKIP'

  // Identity / capability queries — route to QUERY so handleTelegramQuery catches them via identityPatterns
  if (/^(מי אתה|מה אתה|מי את|מה את)\b/.test(t)) return 'QUERY'
  if (/^(מה אתה (יכול|יודע|עושה)|מה היכולות שלך|איך אתה עובד|תסביר את עצמך)/.test(t)) return 'QUERY'
  if (/^(אילו|איזה|מה ה)?\s*(כלים|פיצ'?רים|פקודות|יכולות|אופציות|פונקציות)\s*(יש לך|יש|אתה מציע)?/.test(t)) return 'QUERY'
  if (/^(עזרה|\/help|help)\b/i.test(t)) return 'QUERY'
  if (/^(what can you do|what do you do|who are you|your capabilities|what tools|which tools|what features)/i.test(t)) return 'QUERY'

  // Unambiguous reminder pattern (very common phrasing).
  // Note: JS \b doesn't apply to non-ASCII, so use whitespace/end-of-string for Hebrew.
  if (/^תזכיר לי(\s|$)/.test(t) || /^remind me\b/i.test(t)) return 'REMINDER'

  // Unambiguous image generation
  if (/^(צייר|תצייר|תייצר|ייצר|תיצור) (לי |את )?(תמונה|ציור|איור)/i.test(t)) return 'IMAGE_GEN'
  if (/^(generate|create|draw|make|render) (a |an )?(image|picture|photo|illustration)/i.test(lower)) return 'IMAGE_GEN'

  // Unambiguous web search
  if (/^חפש (לי )?(ב|את)/.test(t) || /^(google|search) /i.test(lower)) return 'WEB_SEARCH'

  // Unambiguous calendar event creation
  if (/^(תכניס|תוסיף|תקבע|הוסף|תקבעי|תוסיפי).{1,80}(ליומן|לקלנדר|לקלינדר|ל-?calendar)(\s|$|[.!])/i.test(t)) return 'CALENDAR'
  if (/^(add|schedule|create|put) .{1,80}(to (my )?calendar|on (my )?calendar|calendar event)\b/i.test(lower)) return 'CALENDAR'

  return null
}

// LLM classification. Few-shot, Hebrew + English, single-word output.
export async function aiClassifyIntent(text, hasMedia, env) {
  const prompt = `You classify Telegram messages sent to a personal knowledge bot. Output exactly one label.

<labels>
QUERY: user wants to retrieve/search/ask about content already saved. Examples: "what do I have on X", "מה יש לי על X", "תמצא לי", "איזה ידע", "תסכם לי", "תביא לי", "what did I save about".
JOURNAL: personal feelings, moods, lived experiences, reflections, gratitude. "I felt...", "היה לי כיף", "הרגשתי", "today was hard".
RECIPE: cooking instructions, ingredients list, recipe steps. "סלט: עגבניות, מלפפון...", "מתכון ל...", recipe-like content.
REMINDER: schedule a future reminder. "תזכיר לי", "remind me to".
WEB_SEARCH: explicit request to search the public web for current info. "חפש בגוגל", "search the web".
IMAGE_GEN: explicit request to generate a new image. "צייר לי", "generate an image of".
CALENDAR: user wants to add a meeting, appointment, flight, or other event to their calendar. Has explicit time/date and/or calendar phrasing. "פגישה מחר ב-3", "תכניס לי את הטיסה ליומן", "תקבע פגישה ל-25/5", "schedule a meeting".
META: an instruction TO the bot about where/how to file or organize content, not content itself. Usually refers to a previous message. "לא ביומן, תשמור את זה בידע", "תעביר את זה למתכונים", "שמור את זה במתכונים" (with no actual content attached), "don't save that", "file this under X".
SAVE: new substantive content worth keeping — ideas, facts, opinions, learnings, mentions of products/people/tools/articles, technical concepts. Default for non-trivial declarative content.
SKIP: greetings, acknowledgements, single-word reactions, content-free small talk.
ASK: genuinely ambiguous between SAVE and SKIP.
</labels>

<examples>
<example><msg>איזה ידע יש לי על עיצוב אתרים?</msg><label>QUERY</label></example>
<example><msg>תמצא לי את 3 הקישורים הכי רלוונטיים</msg><label>QUERY</label></example>
<example><msg>מה שמרתי על RAG?</msg><label>QUERY</label></example>
<example><msg>הרגשתי היום מותש אחרי הפגישה</msg><label>JOURNAL</label></example>
<example><msg>היה לי יום קשה</msg><label>JOURNAL</label></example>
<example><msg>סלט: עגבניות, מלפפון, בצל, לימון, מלח. לחתוך לקוביות</msg><label>RECIPE</label></example>
<example><msg>תזכיר לי להתקשר לאמא בעוד שעה</msg><label>REMINDER</label></example>
<example><msg>פגישה מחר ב-3 עם דני</msg><label>CALENDAR</label></example>
<example><msg>תכניס לי את הטיסה הזאת ליומן</msg><label>CALENDAR</label></example>
<example><msg>תקבע ל-25/5 ב-10:00 פגישה עם הצוות</msg><label>CALENDAR</label></example>
<example><msg>לא ביומן, תשמור את זה בידע</msg><label>META</label></example>
<example><msg>תעביר את זה למתכונים</msg><label>META</label></example>
<example><msg>RAG vs MCP — שני פטרנים לחיבור מודלים למידע חיצוני</msg><label>SAVE</label></example>
<example><msg>טיפ של ויקטור: השתמש ב-Claude לעיצוב מינימליסטי</msg><label>SAVE</label></example>
<example><msg>תודה רבה!</msg><label>SKIP</label></example>
</examples>

${hasMedia ? '\nNote: this message has an attached image/file. Use the caption text to classify; ignore the media for intent purposes.\n' : ''}

<msg>${(text || '').slice(0, 800)}</msg>
<label>`

  try {
    // 70b-fast: same Workers AI billing as 8b, materially better Hebrew —
    // misrouted intents here are what polluted the journal in the past.
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      prompt,
      max_tokens: 6,
    })
    const raw = (r.response || '').trim().toUpperCase().replace(/[^A-Z_]/g, ' ')
    // Match the first valid label found in the response
    for (const label of INTENT_LABELS) {
      if (new RegExp(`\\b${label}\\b`).test(raw)) return label
    }
    return 'ASK'  // unclear output — ask user
  } catch (err) {
    console.error('aiClassifyIntent error:', err)
    return 'SAVE'  // fail safe — preserve content
  }
}

// Main entry point. Returns { intent, source } where source is 'fast' or 'ai'.
export async function routeIntent({ text, hasMedia, hasUrl, env }) {
  const fast = fastPathIntent(text, hasMedia, hasUrl)
  if (fast) return { intent: fast, source: 'fast' }
  const intent = await aiClassifyIntent(text, hasMedia, env)
  return { intent, source: 'ai' }
}

// ── Artifact (HTML generation) ────────────────────────────────────────

export function isArtifactCreateIntent(text) {
  if (!text) return false
  const t = text.trim().toLowerCase()
  if (/^(תכין|תיצור|תבנה|תעשה|צור|בנה|עשה|יצור|הכן)\s.*(html|דף|דשבורד|dashboard|ריפורט|report|ויזואל|visualiz|עמוד|page)/.test(t)) return true
  if (/^(create|build|make|generate)\s.*(html|page|dashboard|report|visualiz|chart)/.test(t)) return true
  return false
}

export function isArtifactEditIntent(text, message) {
  if (!text) return false
  const t = text.trim().toLowerCase()
  // Explicit edit keywords at the start
  const editPattern = /^(שנה|תקן|עדכן|הוסף|הסר|תשפר|ערוך|תוסיף|תסיר|fix|update|add|remove|change|improve|edit)\b/
  if (!editPattern.test(t)) return false
  // Only treat as artifact edit if replying to a bot message (artifact reply)
  return message?.reply_to_message?.from?.is_bot === true
}

export function isQuestion(text) {
  if (!text || text.startsWith('/')) return false
  const t = text.trim()
  if (t.endsWith('?')) return true
  const questionWords = ['מה ', 'איך ', 'מתי ', 'כמה ', 'מי ', 'איפה ', 'למה ', 'האם ', 'אילו ', 'כיצד ',
    'what ', 'how ', 'when ', 'who ', 'where ', 'why ', 'which ', 'can you ', 'do you ', 'did i ', 'show me ']
  const lower = t.toLowerCase()
  return questionWords.some(w => lower.startsWith(w))
}

// Detect questions and follow-ups — routes to conversation instead of save
export function looksLikeQuestion(text) {
  const t = text.trim()
  if (t.endsWith('?')) return true
  const lower = t.toLowerCase()
  if (/^(מה|איך|מי|מתי|איפה|למה|האם|כמה|מהו|מהי|הסבר|ספר|תסביר|תאמר|תגיד|תמצא|חפש|מצא|תבדוק|תסכם|תרחיב|עוד על)\b/.test(lower)) return true
  if (/^(what|how|who|when|where|why|which|can you|could you|tell me|explain|find|search|summarize|list|more about)\b/i.test(t)) return true
  if (/^(ו|אז|אבל|מה עם|ומה|אמרת|הזכרת|דיברת)\s/.test(lower)) return true // follow-ups
  return false
}

export async function classifyIntent(text, env) {
  const t = (text || '').trim()
  if (t.length < 12) return { decision: 'SKIP', reason: 'too short' }

  const lower = t.toLowerCase()
  const trivialPatterns = [
    /^(שלום|היי|אהלן|הי|הלו|מה נשמע|מה קורה|מה המצב)/,
    /^(תודה|תודה רבה|תודה לך|סבבה|אוקיי|אוקי|בסדר|יופי|מעולה|אחלה|נחמד)$/,
    /^(לא|כן|אולי|לא יודע|לא ברור)$/,
    /^(hi|hey|hello|sup|yo|ok|okay|cool|nice|thanks|thank you|lol|haha)\b/i,
    /^(test|בדיקה|check)$/i,
  ]
  if (trivialPatterns.some(p => p.test(lower))) return { decision: 'SKIP', reason: 'trivial' }

  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: `Classify a Telegram message sent to a personal knowledge base bot.

QUERY: the user wants to retrieve, search, or ask about something already saved — e.g. "what do I have on X", "find me links about Y", "summarize what I saved about Z", "what did I write about...", "תמצא לי", "מה יש לי על", "תסכם לי", "תשלוף", "איזה ידע יש לי", "תביא לי", "תחפש".

SAVE: the user is pushing new content to save — ideas, facts, links, quotes, plans, learnings, opinions, reflections, emotional content.

SKIP: greetings, acknowledgements ("ok", "thanks", "got it"), generic small talk with no content.

ASK: genuinely ambiguous — could be save or query.

Message: """${t.slice(0, 800)}"""

Respond with ONLY one word: QUERY, SAVE, SKIP, or ASK`,
      max_tokens: 5,
    })
    const raw = (r.response || '').trim().toUpperCase()
    if (raw.includes('QUERY')) return { decision: 'QUERY', reason: raw }
    if (raw.includes('ASK')) return { decision: 'ASK', reason: raw }
    if (raw.includes('SAVE')) return { decision: 'SAVE', reason: raw }
    if (raw.includes('SKIP')) return { decision: 'SKIP', reason: raw }
    return { decision: 'ASK', reason: 'unclear classifier output' }
  } catch (err) {
    console.error('classifyIntent error:', err)
    return { decision: 'ASK', reason: 'classifier failed — defaulting to ask' }
  }
}

// ── Reminders ─────────────────────────────────────────────────────────

export function isImageGenIntent(text) {
  const t = text.trim()
  if (/^\/image\b|^\/img\b/i.test(t)) return true
  // Hebrew: "צור/ייצר/תצייר/צייר תמונה/ציור/איור..."
  if (/^(צור|ייצר|תצייר|תייצר|תייצור|צייר|תיצור)\s+(תמונה|ציור|איור|תמונת)/i.test(t)) return true
  // English natural language
  if (/^(generate|create|draw|make|render)\s+(a\s+|an\s+)?(image|picture|photo|illustration|drawing|painting)\b/i.test(t)) return true
  if (/\b(draw me|generate image|create image|make me an? image)\b/i.test(t)) return true
  return false
}

export function isReminderIntent(text) {
  const t = text.trim().toLowerCase()
  return t.includes('תזכיר לי') || t.startsWith('/remind') || /remind me\b/i.test(t)
}

export function isJournalIntent(text) {
  const t = text.trim()
  if (/^\/journal\b/i.test(t)) return true
  const patterns = [
    // Explicit journal commands
    /שמור ביומן/i, /כתוב ביומן/i, /תוסיף ליומן/i, /ליומן/i,
    // Feelings — present/past
    /הרגשתי|אני מרגיש|הרגשה ש|מרגיש ש/i,
    /אני (שמח|עצוב|מתוסכל|מרוצה|גאה|מודאג|לחוץ|רגוע|נרגש|מתרגש|כועס|פגוע|אבוד|תקוע|מבולבל|מותש|בעננים|מאוכזב|נהנה|אסיר תודה|מודה)/i,
    /(שמחתי|עצבתי|נהניתי|התרגשתי|פחדתי|התעצבנתי|התאכזבתי|הופתעתי|נדהמתי|נרגעתי|הסתחררתי|כעסתי)/i,
    // "Had a [feeling] [time/place]" — covers "היה לי כיף בים"
    /היה לי (כיף|טוב|נחמד|מעולה|נהדר|מדהים|קשה|רע|מעצבן|מטריד|מבאס|מרגש|חשוב)/i,
    /(כיף|טוב|נחמד|נהדר|מדהים|מעצבן|מבאס|מרגש) לי/i,
    // Days/experiences
    /(יום|בוקר|ערב|לילה|שבוע|פגישה|שיחה|אימון|טיול|חוויה) (טוב|רע|קשה|מעולה|נהדר|מדהים|מוצלח|כושל|מתסכל|מעצבן|מרגש|נחמד)/i,
    // Insights / reflections
    /הבנתי ש|למדתי ש|שמתי לב ש|חשבתי ש|גיליתי ש|הסקתי ש/i,
    /^תובנה[: ]/i, /^תובנה$/i, /^רפלקציה[: ]/i,
    /עשה לי טוב|לא עשה לי טוב|עזר לי|לא עזר לי/i,
    /הייתי מודע|אני מודע ל/i,
    /מה שעבד|מה שלא עבד/i,
    // Gratitude
    /(תודה|מודה) ש(זה|היה|זכיתי|קיבלתי|פגשתי)/i,
    /אני אסיר תודה|מלא הודיה/i,
    // English
    /grateful for|insight: |reflection: |feeling (good|bad|happy|sad|anxious|grateful|proud|excited|tired|frustrated)/i,
    /^(today|yesterday) (was|i felt|i had)/i,
    /\bi feel\b|\bi'm feeling\b|\bi felt\b/i,
  ]
  return patterns.some(p => p.test(t))
}

// AI-based fallback: detect short personal/emotional messages that regex missed.
// Only runs on short, non-URL, non-question text — to keep latency low.
export async function aiDetectJournal(text, env) {
  const t = (text || '').trim()
  if (!t || t.length > 400) return false
  if (/^https?:\/\//i.test(t)) return false
  if (/[?؟]/.test(t)) return false  // questions handled elsewhere
  if (t.split(/\s+/).length < 2) return false  // single word — skip

  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: `Classify if this Telegram message is a personal journal entry — i.e. the user is sharing a feeling, mood, experience, reflection, or gratitude about their own life.

JOURNAL: feelings, moods, personal experiences, reflections, gratitude, "I had a great day", "I feel tired", "the meeting went well", emotional sharing.
NOT_JOURNAL: links, facts, ideas, references, questions, requests, plans, tasks, names of tools/companies, technical content.

Message: """${t.slice(0, 400)}"""

Respond with ONLY one word: JOURNAL or NOT_JOURNAL`,
      max_tokens: 5,
    })
    const raw = (r.response || '').trim().toUpperCase()
    return raw.includes('JOURNAL') && !raw.includes('NOT')
  } catch (err) {
    console.error('aiDetectJournal error:', err)
    return false
  }
}

// Filing instructions ("save this to recipes", "not in journal") must never be
// saved as content. Routed here from the META intent, and used as a guard in
// handleJournalEntry against classifier misses.
export const META_INSTRUCTION_RE = /^(לא ביומן|אל תשמור|תעביר את זה|שמור את זה ב|תשמור את זה ב|תכניס את זה ל|file this under|don'?t save)/i

export async function aiDetectRecipe(text, env) {
  const t = (text || '').trim()
  if (!t || t.length > 600) return false
  if (/^https?:\/\//i.test(t)) return false
  if (t.split(/\s+/).length < 3) return false
  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: `Classify if this message describes a recipe or food preparation instructions.

RECIPE: ingredients list, cooking steps, dish name with preparation method, "how to make X", food with quantities/methods.
NOT_RECIPE: general food mentions, restaurant reviews, food photos without instructions, feelings about food.

Message: """${t.slice(0, 600)}"""

Respond with ONLY one word: RECIPE or NOT_RECIPE`,
      max_tokens: 5,
    })
    const raw = (r.response || '').trim().toUpperCase()
    return raw.includes('RECIPE') && !raw.includes('NOT')
  } catch (err) {
    console.error('aiDetectRecipe error:', err)
    return false
  }
}

export function isRecipeIntent(text) {
  const t = text.trim()
  if (/^\/recipe\b|^\/מתכון\b/i.test(t)) return true
  return /שמור במתכונים|שמור מתכון|תוסיף למתכונים|למתכונים|זה מתכון|save recipe|save to recipes/i.test(t)
}

// ── Web search via Gemini Google Search grounding ─────────────────────
export function isWebSearchIntent(text) {
  const t = (text || '').trim()
  const lower = t.toLowerCase()
  // Hebrew: use startsWith (word boundaries don't apply to non-ASCII in JS regex)
  if (t.startsWith('חפש ') || t === 'חפש' || t.startsWith('חפש לי ') || lower.includes('חיפוש ב')) return true
  // ASCII: \b is safe
  return /^(search for|find|google)\b/i.test(lower)
    || /\b(search the web|look up online|find online)\b/i.test(lower)
}