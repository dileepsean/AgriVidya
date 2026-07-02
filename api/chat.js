// Vercel serverless — VidyaBot / Assignment Helper / AO-AAO AI Tutor chat proxy to Claude.
// SECURITY (added 2026-07-02): this used to be a fully open proxy — anyone, logged in or
// not, could POST here directly and run up the CLAUDE_API_KEY bill, since the "5 free
// questions" / "3 free answers" limits were only ever tracked in the browser's localStorage
// (trivially reset by clearing storage or opening an incognito tab), and the homepage's
// floating chat bubble had no limit at all, not even that.
//
// Now: requires a real Supabase login (Authorization: Bearer <access_token>, verified against
// Supabase itself — never trust a client-supplied user id), and enforces a DAILY cap tracked
// server-side in Supabase (table chat_usage + RPC increment_chat_usage), so it can't be reset
// from the browser. Buyers of the ₹100 AI Tutor add-on (book_id 'bot') get a much higher daily
// cap, since read.html promises them "ask as much as you need" up to exam day — free-tier users
// (VidyaBot page, Assignment Helper, homepage popup bubble) get a modest daily allowance.
const FREE_DAILY_LIMIT = 8;
const BOT_DAILY_LIMIT = 200;
const MAX_TOKENS_CAP = 800;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'login_required' }); return; }

    const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlycmllbHBqYmJzeGRnYnd6d3p4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NTY5NDMsImV4cCI6MjA5MDAzMjk0M30.v7jeOcfQU7-LAxWFSftnTHMSDbZmiTRJEN19bB1z5RA';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // 1) Verify the login is real by asking Supabase who this token belongs to — never trust
    //    a client-supplied user id, the same class of bug that was fixed in verify-payment.js.
    let userId = null;
    try {
      const who = await fetch(SUPA + '/auth/v1/user', { headers: { 'Authorization': 'Bearer ' + token, 'apikey': ANON } }).then(r => r.json());
      userId = who && who.id;
    } catch (e) {}
    if (!userId) { res.status(401).json({ error: 'login_required' }); return; }

    if (!SERVICE) { res.status(500).json({ error: 'Server not configured' }); return; }
    const H = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

    // 2) Paying AI-Tutor owners get a much higher cap — they were promised near-unlimited use.
    let limit = FREE_DAILY_LIMIT;
    try {
      const acc = await fetch(SUPA + '/rest/v1/book_access?user_id=eq.' + userId + '&book_id=eq.bot&active=eq.true&select=book_id', { headers: H }).then(r => r.json());
      if (Array.isArray(acc) && acc.length) limit = BOT_DAILY_LIMIT;
    } catch (e) {}

    // 3) Atomic check-and-increment of today's usage in one SQL statement (see
    //    increment_chat_usage in Supabase) — can't be reset by clearing browser storage,
    //    and can't race across concurrent requests.
    let allowed = false;
    try {
      const r = await fetch(SUPA + '/rest/v1/rpc/increment_chat_usage', {
        method: 'POST', headers: H,
        body: JSON.stringify({ p_user_id: userId, p_limit: limit })
      });
      allowed = await r.json();
    } catch (e) {}
    if (allowed !== true) { res.status(429).json({ error: 'daily_limit_reached' }); return; }

    const { messages, max_tokens } = req.body;
    const cappedTokens = Math.min(Number(max_tokens) || 600, MAX_TOKENS_CAP);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: cappedTokens,
        system: `You are AgriVidya AI — expert assistant for Food Engineering, Agricultural Engineering, Food Technology and Food Science students in India. Only answer questions related to food engineering, agricultural engineering, food technology, food science, farming, or related exams (GATE, ICAR, NABARD, FCI). If someone asks anything else, say: "I am AgriVidya AI, specialized only in food and agricultural engineering. Please ask me about your subjects or exams!" Never use markdown formatting — no asterisks, no bullet hyphens, no hash symbols. Write in plain sentences only.`,
        messages: messages
      })
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
