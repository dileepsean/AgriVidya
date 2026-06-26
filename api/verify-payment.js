// Vercel serverless — verifies Razorpay signature, then grants book access in Supabase
import crypto from 'crypto';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, user_id, book_id } = b;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) { res.status(400).json({ error: 'Missing fields' }); return; }
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const expected = crypto.createHmac('sha256', secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature) { res.status(400).json({ error: 'Signature mismatch' }); return; }
    const SUPA_URL = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (user_id && SERVICE) {
      // combo grants both papers; otherwise grant the single book purchased
      const books = (book_id === 'combo') ? ['paper1', 'paper2'] : [book_id || 'paper1'];
      const rows = books.map(bk => ({ user_id: user_id, book_id: bk, active: true }));
      await fetch(SUPA_URL + '/rest/v1/book_access', {
        method: 'POST',
        headers: { 'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(rows)
      });
    }
    res.status(200).json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Verification failed' }); }
}
