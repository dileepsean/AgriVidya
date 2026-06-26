export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    if (b.debug === 'envcheck') {
      let rzp = 'no keys';
      if (id && secret) {
        const auth = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
        const rr = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100, currency: 'INR', receipt: 't' }) });
        const d = await rr.json();
        rzp = { status: rr.status, idPrefix: id.slice(0, 9), secretLen: secret.length, err: d.error ? d.error.description : (d.id ? 'OK' : JSON.stringify(d).slice(0, 150)) };
      }
      res.status(200).json({ keys: Object.keys(process.env).filter(k => /razor|supabase|service/i.test(k)), rzp });
      return;
    }
    const amount = Math.round(Number(b.amount));
    if (!amount || amount < 100) { res.status(400).json({ error: 'Invalid amount' }); return; }
    if (!id || !secret) { res.status(401).json({ error: 'Razorpay keys not configured' }); return; }
    const auth = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    const rr = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amount, currency: 'INR', receipt: 'rcpt_' + Date.now(), notes: { book_id: b.book_id || 'paper1', user_id: b.user_id || '' } }) });
    const order = await rr.json();
    if (!rr.ok || !order.id) { res.status(500).json({ error: 'Order creation failed' }); return; }
    res.status(200).json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
}
