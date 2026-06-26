// Vercel serverless — creates a Razorpay order (no npm deps; uses global fetch + Buffer)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const amount = Math.round(Number(b.amount));
    if (!amount || amount < 100) { res.status(400).json({ error: 'Invalid amount' }); return; }
    const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) { res.status(401).json({ error: 'Razorpay keys not configured' }); return; }
    const auth = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    const rr = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, currency: 'INR', receipt: 'rcpt_' + Date.now(), notes: { book_id: b.book_id || 'paper1', user_id: b.user_id || '' } })
    });
    const order = await rr.json();
    if (!rr.ok || !order.id) { res.status(500).json({ error: 'Order creation failed' }); return; }
    res.status(200).json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
}
