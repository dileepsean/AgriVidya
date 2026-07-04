// Vercel serverless — admin dashboard data feed. Service-role powered (never exposed to the
// browser), gated by a shared secret header so this can't be scraped by the public.
// Returns every signed-up user joined with what they own in book_access, plus a best-effort
// cross-check against recent Razorpay payments to flag "paid but access missing" cases —
// the main "missed email / payment issue" scenario Dr Sean asked to see on one screen.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'];
  if (!ADMIN_SECRET || !given || given !== ADMIN_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const H = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

    // 1) every signed-up user (paginate just in case; 1000/page is generous for this project's size)
    let users = [];
    let page = 1;
    while (true) {
      const r = await fetch(SUPA + '/auth/v1/admin/users?per_page=1000&page=' + page, { headers: H }).then(x => x.json());
      const batch = r.users || r || [];
      users = users.concat(batch);
      if (!batch.length || batch.length < 1000) break;
      page++;
      if (page > 10) break; // hard stop, safety
    }

    // 2) all book_access rows
    const access = await fetch(SUPA + '/rest/v1/book_access?select=user_id,book_id,active', { headers: H }).then(r => r.json());
    const ownsByUser = {};
    (access || []).forEach(row => {
      if (row.active === false) return;
      (ownsByUser[row.user_id] = ownsByUser[row.user_id] || []).push(row.book_id);
    });

    // 3) recent Razorpay payments (captured only) — best-effort, used only to flag mismatches.
    //    Not fatal if this fails (e.g. Razorpay hiccup); the user list still renders.
    let payments = [];
    try {
      const keyid = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
      const auth = 'Basic ' + Buffer.from(keyid + ':' + secret).toString('base64');
      const pr = await fetch('https://api.razorpay.com/v1/payments?count=100', { headers: { Authorization: auth } }).then(r => r.json());
      payments = (pr.items || []).filter(p => p.status === 'captured');
    } catch (e) {}

    const GRANTS = { combo: ['paper1', 'paper2'], everything: ['paper1', 'paper2', 'mocks'], mocks: ['mocks'], paper1: ['paper1'], paper2: ['paper2'], bot: ['bot'] };

    // index payments by lowercased email for quick lookup
    const paymentsByEmail = {};
    payments.forEach(p => {
      const email = (p.email || (p.notes && p.notes.email) || '').toLowerCase().trim();
      if (!email || email.endsWith('@razorpay.com')) return;
      (paymentsByEmail[email] = paymentsByEmail[email] || []).push(p);
    });

    const out = users.map(u => {
      const email = (u.email || '').toLowerCase();
      const owns = ownsByUser[u.id] || [];
      const meta = u.user_metadata || {};
      const whatsapp = (meta.whatsapp || meta.phone || '').replace(/\D/g, '');

      // does this email have a captured payment whose implied book_ids aren't fully in owns?
      const pays = paymentsByEmail[email] || [];
      let expectedBooks = new Set();
      pays.forEach(p => {
        const bookId = p.notes && p.notes.book_id;
        const books = GRANTS[bookId];
        if (books) books.forEach(b => expectedBooks.add(b));
      });
      const missing = [...expectedBooks].filter(b => owns.indexOf(b) < 0);

      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        whatsapp: whatsapp || null,
        owns,
        paid_amount_total: pays.reduce((s, p) => s + (p.amount || 0), 0) / 100,
        payment_count: pays.length,
        mismatch: missing.length > 0,
        missing_books: missing
      };
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.status(200).json({ users: out, generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load admin data', detail: String(e && e.message || e) });
  }
}
