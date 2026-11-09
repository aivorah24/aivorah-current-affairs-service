// The service talks to Supabase with the service key, which bypasses RLS, so
// this check is what keeps one student from reading or changing another's
// progress: the Firebase ID token's email must match the email the request is about.
//
// AUTH_ENFORCE=monitor only logs what would be blocked (local dev without a
// Firebase service account). Anything else — including unset — enforces.
const firebaseAdmin = require('../services/firebaseAdmin');

const enforcing = () => (process.env.AUTH_ENFORCE || 'enforce').toLowerCase() !== 'monitor';

function normalizeEmail(value) {
  return String(value || '').toLowerCase().trim();
}

async function decodeBearer(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return { status: 'missing' };
  if (!firebaseAdmin) return { status: 'unconfigured' };
  try {
    return { status: 'ok', decoded: await firebaseAdmin.auth().verifyIdToken(match[1]) };
  } catch {
    return { status: 'invalid' };
  }
}

function deny(req, res, next, code, error) {
  if (enforcing()) return res.status(code).json({ error });
  console.warn(`[auth-monitor] would ${code} ${req.method} ${req.originalUrl}: ${error}`);
  return next();
}

// getEmail(req) returns the student the request acts on. When it returns
// nothing the route has no per-student data and the check is skipped.
function requireSelf(getEmail) {
  return async (req, res, next) => {
    const target = normalizeEmail(getEmail(req));
    if (!target) return next();
    const { status, decoded } = await decodeBearer(req);
    if (status === 'unconfigured') return deny(req, res, next, 500, 'Auth is not configured on this server');
    if (status !== 'ok') return deny(req, res, next, 401, 'Sign in required');
    const tokenEmail = normalizeEmail(decoded.email);
    if (!tokenEmail || tokenEmail !== target) {
      return deny(req, res, next, 403, 'You can only see or change your own progress');
    }
    req.authEmail = tokenEmail;
    return next();
  };
}

module.exports = { requireSelf, normalizeEmail };
