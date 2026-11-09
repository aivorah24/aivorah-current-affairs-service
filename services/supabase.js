const { createClient } = require('@supabase/supabase-js');

// Strip ALL whitespace — some hosts wrap long env vars with \n + spaces inside
// the value, which breaks the auth header ("Headers.set: invalid header value").
// SUPABASE_KEY is this service's name for it; SUPABASE_SERVICE_KEY (what the other
// aivorah services use) is accepted too so one shared env group works for all.
const url = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
const key = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '').replace(/\s+/g, '');

if (!url || !key) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_KEY not set — database calls will fail');
}

const supabase = createClient(url || 'http://localhost:54321', key || 'missing-key', {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
