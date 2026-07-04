// Vercel serverless — lets the admin dashboard grant access with one click instead of
// hand-running SQL in the Supabase editor. Same shared-secret gate as admin-data.js.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'];
  if (!ADMIN_SECRET || !given || given !== ADMIN_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}'); if (!b) b = {};
    const email = String(b.email || '').toLowerCase().trim();
    const book_ids = Array.isArray(b.book_ids) ? b.book_ids.filter(Boolean) : [];
    const VALID = ['paper1', 'paper2', 'mocks', 'bot'];
    const books = book_ids.filter(x => VALID.indexOf(x) >= 0);
    if (!email || !books.length) { res.status(400).json({ error: 'email and at least one valid book_id required' }); return; }

    const SUPA = process.env.SUPABASE_URL || 'https://yrrielpjbbsxdgbwzwzx.supabase.co';
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const H = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

    // find the user by email (admin API supports exact-match email filter)
    const lookup = await fetch(SUPA + '/auth/v1/admin/users?email=' + encodeURIComponent(email), { headers: H }).then(r => r.json());
    const user = (lookup.users || lookup || []).find(u => (u.email || '').toLowerCase() === email);
    if (!user) { res.status(404).json({ error: 'No account found for that email — they need to sign up on the site first.' }); return; }

    const grantRes = await fetch(SUPA + '/rest/v1/book_access', {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(books.map(bk => ({ user_id: user.id, book_id: bk, active: true })))
    });
    if (!grantRes.ok) { const t = await grantRes.text(); res.status(500).json({ error: 'Grant failed', detail: t }); return; }

    res.status(200).json({ success: true, email, granted: books });
  } catch (e) {
    res.status(500).json({ error: 'Grant failed', detail: String(e && e.message || e) });
  }
}
