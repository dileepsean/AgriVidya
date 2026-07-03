// Vercel serverless — creates the Razorpay order.
// Price is decided SERVER-SIDE from book_id (never trusted from the browser), so the
// amount charged can't be tampered with via devtools/network edits.
// Optional promo_code applies a discount. Promo codes are only ever handed out
// manually (e.g. on WhatsApp when someone asks) — never advertised on the site —
// so keep this list short and only add codes you're actively giving out.
const PRICES = {           // in paise
  paper1: 24900,
  paper2: 24900,
  combo: 45900,
  mocks: 99900,
  everything: 129900,
  bot: 10000
};
const PROMOS = {           // CODE -> either { percent: N } off every product, or
                            // { fixed: {book_id: paise}, maxUses: N } overriding specific product prices
                            // with a redemption cap enforced via public.promo_redemptions
  AAO15: { percent: 15 },
  // Personal code for Tajuddin (tajuddinmmmakandar@gmail.com) — shared with up to 10 people.
  // everything ₹1299->₹1000, mocks ₹999->₹750. Not advertised anywhere.
  TAJUDDIN10: { fixed: { everything: 100000, mocks: 75000 }, maxUses: 10 },
  // Personal code for Ramya — shared with up to 5 friends. Same combo pricing as above.
  RAMYA5: { fixed: { everything: 100000, mocks: 75000 }, maxUses: 5 }
};
const TEST_CODE = 'DRSEANTEST'; // Dr Sean's own ₹1 test-purchase code — keep secret, do not publish anywhere

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    const bookId = b.book_id;
    if (!PRICES[bookId]) { res.status(400).json({ error: 'Invalid product' }); return; }

    let amount = PRICES[bookId];
    const code = String(b.promo_code || '').toUpperCase().trim();
    const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let promoApplied = '';
    if (code === TEST_CODE) {
      amount = 100; // ₹1 — testing only
    } else if (code && PROMOS[code]) {
      const promo = PROMOS[code];
      let capOk = true;
      if (promo.maxUses && SERVICE) {
        try {
          const cr = await fetch(SUPA + '/rest/v1/promo_redemptions?code=eq.' + encodeURIComponent(code) + '&select=id',
            { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, Prefer: 'count=exact', Range: '0-0' } });
          const range = cr.headers.get('content-range') || '';
          const total = parseInt(range.split('/')[1] || '0', 10);
          if (total >= promo.maxUses) capOk = false;
        } catch (e) { /* if the check fails, fall back to full price rather than risk overselling */ capOk = false; }
      }
      if (capOk) {
        if (promo.fixed && promo.fixed[bookId] != null) { amount = promo.fixed[bookId]; promoApplied = code; }
        else if (promo.percent) { amount = Math.round(amount * (100 - promo.percent) / 100); promoApplied = code; }
      }
    }
    if (amount < 100) amount = 100;

    if (!id || !secret) { res.status(401).json({ error: 'Razorpay keys not configured' }); return; }
    const auth = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    const rr = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, currency: 'INR', receipt: 'rcpt_' + Date.now(), notes: { book_id: bookId, promo: promoApplied, user_id: b.user_id || '' } })
    });
    const order = await rr.json();
    if (!rr.ok || !order.id) { res.status(500).json({ error: 'Order creation failed' }); return; }

    // reserve a redemption slot for capped promo codes (best-effort; unique order_id prevents double-count)
    if (promoApplied && PROMOS[promoApplied] && PROMOS[promoApplied].maxUses && SERVICE) {
      try {
        await fetch(SUPA + '/rest/v1/promo_redemptions', {
          method: 'POST',
          headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: promoApplied, order_id: order.id, book_id: bookId })
        });
      } catch (e) {}
    }

    res.status(200).json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
}
