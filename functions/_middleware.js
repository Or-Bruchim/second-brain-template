// Second Brain — Pages middleware
// Gates the public Pages domain behind a passphrase.
// Mirrors the site-gate Worker's auth so both entry points use the same cookie.

const COOKIE_NAME = "brain_auth"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function verifyCookie(cookieValue, secret) {
  if (!cookieValue) return false
  const [payload, sig] = cookieValue.split(".")
  if (!payload || !sig) return false
  const expected = await hmac(secret, payload)
  if (sig !== expected) return false
  const exp = parseInt(payload, 36)
  return Number.isFinite(exp) && exp > Date.now()
}

async function makeCookie(secret) {
  const exp = (Date.now() + COOKIE_MAX_AGE * 1000).toString(36)
  const sig = await hmac(secret, exp)
  return `${exp}.${sig}`
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Second Brain</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@700;800&family=Assistant:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    html, body { height: 100% }
    body {
      font-family: "Assistant", system-ui, sans-serif;
      background: linear-gradient(135deg, #2a4a62 0%, #355872 40%, #5a8aaa 75%, #7AAACE 100%);
      display: flex; align-items: center; justify-content: center;
      color: #0f172a;
      padding: 24px;
      min-height: 100vh;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px);
      background-size: 28px 28px;
      pointer-events: none;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(20px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    @keyframes shake {
      0%,100% { transform: translateX(0) }
      20%      { transform: translateX(-8px) }
      40%      { transform: translateX(8px) }
      60%      { transform: translateX(-5px) }
      80%      { transform: translateX(5px) }
    }
    .card {
      background: rgba(255,255,255,0.97);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.6);
      border-radius: 24px;
      padding: 48px 40px 40px;
      width: min(400px, 100%);
      box-shadow: -10px 8px 32px rgba(0,0,0,0.22);
      text-align: center;
      animation: fadeUp 0.4s ease-out both;
    }
    .card.shake { animation: shake 0.4s ease-out }
    .lock { font-size: 36px; margin-bottom: 16px; line-height: 1 }
    h1 {
      font-family: "Urbanist", sans-serif;
      font-size: 32px;
      font-weight: 800;
      color: #201f87;
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }
    .tagline {
      font-size: 13px;
      color: #64748b;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .hints {
      display: flex;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 28px;
    }
    .hint-pill {
      font-size: 11px;
      font-weight: 500;
      color: rgba(32,31,135,0.7);
      background: rgba(32,31,135,0.07);
      border-radius: 100px;
      padding: 4px 10px;
    }
    .divider {
      border: none;
      border-top: 1px solid #f1f5f9;
      margin-bottom: 24px;
    }
    input {
      width: 100%;
      padding: 13px 16px;
      border: 1.5px solid #e2e8f0;
      border-radius: 12px;
      font-size: 15px;
      font-family: inherit;
      margin-bottom: 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
      background: #f8fafc;
    }
    input:focus {
      outline: none;
      border-color: #7AAACE;
      background: white;
      box-shadow: 0 0 0 3px rgba(122,170,206,0.18);
    }
    input.invalid { border-color: #ef4444; background: #fff5f5 }
    button {
      width: 100%;
      padding: 14px;
      background: #201f87;
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(32,31,135,0.28) }
    button:active { transform: translateY(0); box-shadow: none }
    .err {
      color: #ef4444;
      font-size: 13px;
      margin-bottom: 10px;
      min-height: 18px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <form class="card${error ? ' shake' : ''}" method="POST" action="/__auth">
    <div class="lock">🧠</div>
    <h1>Second Brain</h1>
    <p class="tagline">Notes, decisions, and thinking — curated.</p>
    <div class="hints">
      <span class="hint-pill">📝 Notes</span>
      <span class="hint-pill">⚖️ Decisions</span>
      <span class="hint-pill">📥 Inbox</span>
      <span class="hint-pill">🧪 Projects</span>
    </div>
    <hr class="divider">
    <p class="err">${error || ""}</p>
    <input type="password" name="passphrase" placeholder="Enter passphrase…" autofocus required class="${error ? 'invalid' : ''}">
    <button type="submit">Unlock →</button>
  </form>
</body>
</html>`
}

export async function onRequest(context) {
  const { request, env, next } = context
  const url = new URL(request.url)
  const secret = env.SITE_PASSPHRASE

  if (!secret) {
    return new Response("Server misconfigured: SITE_PASSPHRASE not set", { status: 500 })
  }

  if (url.pathname === "/__auth" && request.method === "POST") {
    const form = await request.formData()
    const submitted = (form.get("passphrase") || "").toString()
    if (submitted !== secret) {
      return new Response(loginPage("Wrong passphrase"), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }
    const cookie = await makeCookie(secret)
    const dest = url.searchParams.get("next") || "/"
    return new Response(null, {
      status: 303,
      headers: {
        Location: dest,
        "Set-Cookie": `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
      },
    })
  }

  if (url.pathname === "/__logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    })
  }

  const cookieHeader = request.headers.get("Cookie") || ""
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  const authed = await verifyCookie(match?.[1], secret)

  if (!authed) {
    // Subresources (scripts, JSON, images) must never receive the HTML login
    // page: a page loaded from cache with an expired cookie would silently get
    // HTML instead of its scripts and die with "X is not defined".
    const dest = request.headers.get("Sec-Fetch-Dest")
    const wantsHtml = (request.headers.get("Accept") || "").includes("text/html")
    const isDocument = dest ? dest === "document" : wantsHtml
    if (!isDocument) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      })
    }
    return new Response(loginPage(""), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    })
  }

  return next()
}
