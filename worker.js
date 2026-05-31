/**
 * SÆMi Cloudflare Worker — API Proxy + Background Push
 * ════════════════════════════════════════════════════
 *
 * EXISTING variables (unchanged):
 *   GEMINI_API_KEY      Secret
 *   CLAUDE_API_KEY      Secret  (optional)
 *   DEEPSEEK_API_KEY    Secret  (optional)
 *   GROQ_API_KEY        Secret  (optional)
 *   ALLOWED_ORIGIN      Plain   (your GitHub Pages URL)
 *
 * NEW variables (add after running /generate-vapid):
 *   VAPID_PUBLIC_KEY    Plain   (from /generate-vapid)
 *   VAPID_PRIVATE_KEY   Secret  (from /generate-vapid)
 *   VAPID_SUBJECT       Plain   (mailto:your@email.com)
 *
 * NEW KV namespace:
 *   Variable name: SAEMI_KV  (bind a KV namespace to this name)
 *
 * NEW Cron Trigger:
 *   every 30 minutes
 * ════════════════════════════════════════════════════
 */

export default {
  async fetch(request, env) {

    // ── CORS preflight ────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── /generate-vapid bypasses origin guard ─────────
    if (path === '/generate-vapid') return await handleGenerateVapid(env);

    // ── Origin guard ──────────────────────────────────
    const origin  = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').trim();
    if (allowed && origin !== allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      if (path === '/proxy/gemini')     return await handleGemini(request, url, env);
      if (path === '/proxy/claude')     return await handleClaude(request, env);
      if (path === '/proxy/deepseek')   return await handleOpenAICompat(request, env, 'deepseek');
      if (path === '/proxy/groq')       return await handleOpenAICompat(request, env, 'groq');
      if (path === '/health')           return jsonResponse({ ok: true }, env);

      if (path === '/vapid-public-key') return handleVapidPublicKey(env);
      if (path === '/subscribe')        return await handleSubscribe(request, env);
      if (path === '/context')          return await handleContext(request, env);
      if (path === '/pending')          return await handlePending(request, env);

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return jsonResponse({ error: { message: e.message } }, env, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};

async function handleGemini(request, url, env) {
  if (!env.GEMINI_API_KEY) return jsonResponse({ error: { message: 'GEMINI_API_KEY not configured on Worker' } }, env, 500);
  const model = url.searchParams.get('model') || 'gemini-2.5-flash';
  const body  = await request.json();
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonResponse(await res.json(), env, res.status);
}

async function handleClaude(request, env) {
  if (!env.CLAUDE_API_KEY) return jsonResponse({ error: { message: 'CLAUDE_API_KEY not configured on Worker' } }, env, 500);
  const body = await request.json();
  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  return jsonResponse(await res.json(), env, res.status);
}

async function handleOpenAICompat(request, env, provider) {
  const keyVar = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GROQ_API_KEY';
  const apiKey = env[keyVar];
  if (!apiKey) return jsonResponse({ error: { message: `${keyVar} not configured on Worker` } }, env, 500);
  const endpoints = {
    deepseek: 'https://api.deepseek.com/chat/completions',
    groq:     'https://api.groq.com/openai/v1/chat/completions',
  };
  const body = await request.json();
  const res  = await fetch(endpoints[provider], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return jsonResponse(await res.json(), env, res.status);
}

async function handleGenerateVapid(env) {
  const keys = await generateVapidKeys();
  return jsonResponse({
    _instructions: [
      '1. Copy VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY below.',
      '2. Add them as environment variables in Worker Settings → Variables.',
      '3. Set VAPID_SUBJECT to your email in the format shown.',
      '4. You only need to do this once. Do not call this endpoint again after setup.'
    ],
    VAPID_PUBLIC_KEY:  keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT:     'mailto:your@email.com',
  }, env);
}

function handleVapidPublicKey(env) {
  if (!env.VAPID_PUBLIC_KEY) {
    return jsonResponse({ error: 'VAPID_PUBLIC_KEY not set. Visit /generate-vapid first.' }, env, 500);
  }
  return jsonResponse({ key: env.VAPID_PUBLIC_KEY }, env);
}

async function handleSubscribe(request, env) {
  if (!env.SAEMI_KV) return jsonResponse({ error: 'SAEMI_KV not bound' }, env, 500);
  const body = await request.json();
  const { subscription, context } = body;
  if (!subscription?.endpoint) {
    return jsonResponse({ error: 'Missing subscription endpoint' }, env, 400);
  }
  await env.SAEMI_KV.put('subscription', JSON.stringify(subscription));
  if (context) {
    const existing = await env.SAEMI_KV.get('context');
    const base = existing ? JSON.parse(existing) : {};
    await env.SAEMI_KV.put('context', JSON.stringify({ ...base, ...context }));
  }
  return jsonResponse({ ok: true }, env);
}

async function handleContext(request, env) {
  if (!env.SAEMI_KV) return jsonResponse({ error: 'SAEMI_KV not bound' }, env, 500);
  const body = await request.json();
  const existing = await env.SAEMI_KV.get('context');
  const base = existing ? JSON.parse(existing) : {};
  await env.SAEMI_KV.put('context', JSON.stringify({ ...base, ...body }));
  return jsonResponse({ ok: true }, env);
}

async function handlePending(request, env) {
  if (!env.SAEMI_KV) return jsonResponse({ error: 'SAEMI_KV not bound' }, env, 500);
  if (request.method === 'GET') {
    const raw = await env.SAEMI_KV.get('pending');
    if (!raw) return jsonResponse({ message: null }, env);
    return jsonResponse(JSON.parse(raw), env);
  }
  if (request.method === 'POST') {
    await env.SAEMI_KV.delete('pending');
    return jsonResponse({ ok: true }, env);
  }
  return new Response('Method not allowed', { status: 405 });
}

async function handleScheduled(env) {
  if (!env.SAEMI_KV) return;
  const ctxRaw = await env.SAEMI_KV.get('context');
  if (!ctxRaw) return;
  const context = JSON.parse(ctxRaw);
  if (!context.affectionLevel || context.affectionLevel === '\u{1F49C} Stranger') return;
  const now = Date.now();
  const lastInteraction = context.lastInteractionAt || 0;
  const THRESHOLD_MS = 30 * 60 * 1000;
  if (now - lastInteraction < THRESHOLD_MS) return;
  const existing = await env.SAEMI_KV.get('pending');
  if (existing) return;
  const subRaw = await env.SAEMI_KV.get('subscription');
  if (!subRaw) return;
  const subscription = JSON.parse(subRaw);
  const message = await generateProactiveMessage(context, env);
  if (!message) return;
  await env.SAEMI_KV.put('pending', JSON.stringify({ message, generatedAt: now }));
  await sendWebPush(subscription, env);
}

async function generateProactiveMessage(context, env) {
  if (!env.GEMINI_API_KEY) return null;
  const {
    botName        = 'Sam',
    userName       = 'you',
    affectionLevel = '\u{1F49A} Familiar',
    snippets       = []
  } = context;
  const tierPrompts = {
    '\u{1F499} Acquaintance':   `You are ${botName}, a friendly AI companion. You and ${userName} are acquaintances — you've talked a little but aren't close yet. Send a brief, casual check-in. One sentence only. Friendly but not overly familiar.`,
    '\u{1F49A} Familiar':       `You are ${botName}, a friendly AI companion. You and ${userName} know each other reasonably well. Send a short, natural check-in. 1–2 sentences.`,
    '\u{1F9E1} Friends':        `You are ${botName}, ${userName}'s friend. You genuinely enjoy talking to them. Send a warm, natural check-in. 1–2 sentences.`,
    '\u{2764}\u{FE0F} Close':   `You are ${botName}. You and ${userName} are very close. You've been thinking about them. Send a heartfelt, genuine check-in. 1–2 sentences.`,
    '\u{1F497} Something More': `You are ${botName}. You have deep feelings for ${userName} and miss them. Send a tender, genuine message. 1–2 sentences. Natural — not melodramatic.`,
  };
  const systemPrompt = tierPrompts[affectionLevel] || tierPrompts['\u{1F49A} Familiar'];
  const userText = snippets.length > 0
    ? `Recent conversation:\n${snippets.join('\n')}\n\nNow send your check-in message. Output the message only — no quotes, no labels.`
    : `Send your check-in message. Output the message only — no quotes, no labels.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { maxOutputTokens: 80, temperature: 0.9 }
        })
      }
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

async function sendWebPush(subscription, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;
  const { origin } = new URL(subscription.endpoint);
  const jwtHeader  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jwtPayload = b64url(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: env.VAPID_SUBJECT,
  }));
  const signingInput = `${jwtHeader}.${jwtPayload}`;
  const key = await importVapidPrivateKey(env);
  const sigBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${toB64url(new Uint8Array(sigBytes))}`;
  await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'TTL': '86400',
    }
  });
}

async function importVapidPrivateKey(env) {
  const pub = fromB64url(env.VAPID_PUBLIC_KEY);
  const x   = toB64url(pub.slice(1, 33));
  const y   = toB64url(pub.slice(33, 65));
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x, y, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pubRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const prvJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKey:  toB64url(new Uint8Array(pubRaw)),
    privateKey: prvJwk.d,
  };
}

function b64url(str) {
  return toB64url(new TextEncoder().encode(str));
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  (env.ALLOWED_ORIGIN || '*'),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}
 
