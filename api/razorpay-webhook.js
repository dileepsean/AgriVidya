// Vercel serverless — Razorpay WEBHOOK (server-to-server).
// Razorpay calls this directly the instant a payment is captured, independent of the
// buyer's browser. This is the reliability backstop for api/verify-payment.js: if the
// buyer closes their tab right after paying, THIS still creates their account, grants
// access, and logs the attempt — so nobody falls through the cracks silently again.
//
// SETUP (one-time, done by Dr Sean — involves secrets Claude cannot enter):
// 1. Razorpay Dashboard -> Settings -> Webhooks -> Add New Webhook
//      Webhook URL:  https://www.agrividya.in/api/razorpay-webhook
//      Secret:       (let Razorpay generate one, or set your own strong string)
//      Active events: payment.captured
//    Save, then copy the Secret shown.
// 2. Vercel -> AgriVidya project -> Settings -> Environment Variables -> Add:
//      Name:  RAZORPAY_WEBHOOK_SECRET
//      Value: (the secret copied in step 1)
//      Environment: Production
//    Save, then redeploy (uploading this file will trigger a redeploy anyway).
// 3. Also requires a public.payment_log table in Supabase (already created).

import crypto from 'crypto';

// Vercel must NOT pre-parse the body — signature verification needs the raw bytes.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let raw;
  try { raw = await readRawBody(req); } catch (e) { res.status(400).end(); return; }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  if (!secret || !signature) { res.status(400).json({ error: 'Missing webhook secret/signature' }); return; }

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (expected !== signature) { res.status(400).json({ error: 'Invalid signature' }); return; }

  let body;
  try { body = JSON.parse(raw); } catch (e) { res.status(400).end(); return; }

  // Ack everything, but only act on payment.captured.
  if (body.event !== 'payment.captured') { res.status(200).json({ ok: true, skipped: body.event }); return; }

  const payment = body.payload && body.payload.payment && body.payload.payment.entity;
  if (!payment) { res.status(200).json({ ok: true, skipped: 'no payment entity' }); return; }

  const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const H = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

  // Idempotency: Razorpay retries webhooks on failure, and this can also race with
  // verify-payment.js. If we've already logged a successful grant for this payment,
  // don't do it again (avoids duplicate magic-link emails).
  try {
    const existing = await fetch(SUPA + '/rest/v1/payment_log?payment_id=eq.' + encodeURIComponent(payment.id) + '&select=granted', { headers: H }).then((r) => r.json());
    if (Array.isArray(existing) && existing.some((r) => r.granted)) {
      res.status(200).json({ ok: true, already_granted: true }); return;
    }
  } catch (e) { /* fall through and try anyway */ }

  const email = (payment.email || '').toLowerCase().trim();
  const contact = payment.contact || '';
  let book_id = (payment.notes && payment.notes.book_id) || '';

  // book_id is set as an order note at checkout (api/create-order.js). Fall back to
  // fetching the order directly if it's missing from the payment payload.
  if (!book_id && payment.order_id) {
    try {
      const keyid = process.env.RAZORPAY_KEY_ID, keysecret = process.env.RAZORPAY_KEY_SECRET;
      const auth = 'Basic ' + Buffer.from(keyid + ':' + keysecret).toString('base64');
      const order = await fetch('https://api.razorpay.com/v1/orders/' + payment.order_id, { headers: { Authorization: auth } }).then((r) => r.json());
      book_id = (order.notes && order.notes.book_id) || '';
    } catch (e) { /* ignore, default below */ }
  }
  if (!book_id) book_id = 'paper1';

  let granted = false, errMsg = null, userId = null;

  try {
    if (email && SERVICE) {
      let redirect = 'https://www.agrividya.in/read.html';
      if (book_id === 'paper2') redirect = 'https://www.agrividya.in/read.html?b=paper2';
      else if (book_id === 'mocks') redirect = 'https://www.agrividya.in/mock.html';

      const gl = await fetch(SUPA + '/auth/v1/admin/generate_link', {
        method: 'POST', headers: H,
        body: JSON.stringify({ type: 'magiclink', email, options: { redirect_to: redirect, data: { whatsapp: contact } } }),
      }).then((r) => r.json());
      userId = (gl.user && gl.user.id) || gl.id || null;

      if (userId && contact) {
        await fetch(SUPA + '/auth/v1/admin/users/' + userId, {
          method: 'PUT', headers: H,
          body: JSON.stringify({ user_metadata: { whatsapp: contact }, email_confirm: true }),
        });
      }

      if (userId) {
        const GRANTS = {
          combo: ['paper1', 'paper2'],
          everything: ['paper1', 'paper2', 'mocks'],
          mocks: ['mocks'],
          paper1: ['paper1'],
          paper2: ['paper2'],
          bot: ['bot'],
        };
        const books = GRANTS[book_id] || [book_id];
        const gr = await fetch(SUPA + '/rest/v1/book_access', {
          method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(books.map((bk) => ({ user_id: userId, book_id: bk, active: true }))),
        });
        granted = gr.ok;
        if (!gr.ok) errMsg = 'grant failed: HTTP ' + gr.status;
      } else {
        errMsg = 'no user_id returned from generate_link';
      }
    } else {
      errMsg = !email ? 'no email on payment' : 'no SUPABASE_SERVICE_ROLE_KEY configured';
    }
  } catch (e) {
    errMsg = String((e && e.message) || e);
  }

  // Always log the attempt — success or failure — so nothing is invisible again.
  try {
    await fetch(SUPA + '/rest/v1/payment_log?on_conflict=payment_id', {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        payment_id: payment.id,
        order_id: payment.order_id,
        email, contact, book_id,
        amount: payment.amount,
        granted, error: errMsg,
        source: 'webhook',
      }]),
    });
  } catch (e) { /* logging failure shouldn't fail the webhook ack */ }

  res.status(200).json({ ok: true, granted });
}
