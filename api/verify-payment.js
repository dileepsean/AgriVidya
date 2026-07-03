// Vercel serverless — verifies Razorpay signature, auto-creates the buyer's account
// from the email/phone collected at checkout, grants access, returns a one-tap login link.
import crypto from 'crypto';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = b;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) { res.status(400).json({ error: 'Missing fields' }); return; }
    const secret = process.env.RAZORPAY_KEY_SECRET, keyid = process.env.RAZORPAY_KEY_ID;
    const expected = crypto.createHmac('sha256', secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature) { res.status(400).json({ error: 'Signature mismatch' }); return; }

    const auth = 'Basic ' + Buffer.from(keyid + ':' + secret).toString('base64');

    // SECURITY: the product being unlocked must come from the Razorpay ORDER itself (set
    // server-side in api/create-order.js's notes.book_id), never from whatever the browser
    // sends here. Otherwise a real (cheap) payment's valid signature could be replayed with a
    // different book_id to unlock a more expensive product for free.
    let book_id = null;
    try {
      const order = await fetch('https://api.razorpay.com/v1/orders/' + razorpay_order_id, { headers: { 'Authorization': auth } }).then(r => r.json());
      book_id = order && order.notes && order.notes.book_id;
    } catch (e) {}
    if (!book_id) { res.status(400).json({ error: 'Could not verify order' }); return; }

    const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const H = { 'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

    // 1) get the buyer's email + phone from the Razorpay payment
    let email = '', contact = '';
    try {
      const pay = await fetch('https://api.razorpay.com/v1/payments/' + razorpay_payment_id, { headers: { 'Authorization': auth } }).then(r => r.json());
      email = (pay.email || '').toLowerCase().trim(); contact = pay.contact || '';
    } catch (e) {}
    // Some payment methods (UPI intent especially) don't hand Razorpay a real email — it
    // falls back to a placeholder like "void@razorpay.com". Trusting that would silently
    // create/grant access to an account the buyer can never reach. Prefer the email the
    // buyer typed directly into our own checkout page (b.email) — the client now always
    // collects this before opening Razorpay for guest buyers — and never trust @razorpay.com.
    if (email.endsWith('@razorpay.com')) email = '';
    const clientEmail = String(b.email || '').toLowerCase().trim();
    if (clientEmail && clientEmail.includes('@')) email = clientEmail;

    let userId = b.user_id || null, login_link = null;
    // where to send the buyer after login (mocks => mock page; paper2 => paper2 reader)
    let redirect = 'https://www.agrividya.in/read.html';
    if (book_id === 'paper2') redirect = 'https://www.agrividya.in/read.html?b=paper2';
    else if (book_id === 'mocks') redirect = 'https://www.agrividya.in/mock.html';

    // 2) ensure an account exists for this email and get a one-tap login link.
    //    Skip this for buyers who were already logged in when they paid (b.user_id set) —
    //    we already know their account; no need to resolve one from email.
    if (email && SERVICE && !b.user_id) {
      try {
        const gl = await fetch(SUPA + '/auth/v1/admin/generate_link', {
          method: 'POST', headers: H,
          body: JSON.stringify({ type: 'magiclink', email: email, options: { redirect_to: redirect, data: { whatsapp: contact } } })
        }).then(r => r.json());
        login_link = gl.action_link || (gl.properties && gl.properties.action_link) || null;
        userId = (gl.user && gl.user.id) || gl.id || userId;
        // make sure whatsapp is saved on the account
        if (userId && contact) {
          await fetch(SUPA + '/auth/v1/admin/users/' + userId, { method: 'PUT', headers: H, body: JSON.stringify({ user_metadata: { whatsapp: contact }, email_confirm: true }) });
        }
      } catch (e) {}
    }

    // 3) grant access — map each product to the book_ids it unlocks
    //    combo      = both papers (material)
    //    mocks      = all mock tests
    //    everything = both papers + mocks
    if (userId && SERVICE) {
      const GRANTS = {
        combo: ['paper1', 'paper2'],
        everything: ['paper1', 'paper2', 'mocks'],
        mocks: ['mocks'],
        paper1: ['paper1'],
        paper2: ['paper2'],
        bot: ['bot']
      };
      const books = GRANTS[book_id];
      if (!books) { res.status(400).json({ error: 'Unknown product' }); return; }
      await fetch(SUPA + '/rest/v1/book_access', {
        method: 'POST',
        headers: { ...H, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(books.map(bk => ({ user_id: userId, book_id: bk, active: true })))
      });
    }

    res.status(200).json({ success: true, login_link: login_link });
  } catch (e) { res.status(500).json({ error: 'Verification failed' }); }
}
