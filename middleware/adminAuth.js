// The admin content tool (routes/admin.js) is for the Aivorah team only: the
// same email allowlist as the Aivorah admin portal
// (aivorah-platform-admin-service/middleware/auth.js), plus extra editors in
// ADMIN_EMAILS / CA_EDITOR_EMAILS (comma-separated) on Render.
const firebaseAdmin = require('../services/firebaseAdmin');
const { normalizeEmail } = require('./auth');

function allowedEditors(env = process.env) {
  const list = [
    'kannansaimohan2003@gmail.com',
    'preddy6678@gmail.com',
    'admin@aivorah.ai',
    env.ADMIN_EMAIL || '',
    ...(env.ADMIN_EMAILS || '').split(','),
    ...(env.CA_EDITOR_EMAILS || '').split(','),
  ];
  return new Set(list.map(normalizeEmail).filter(Boolean));
}

async function requireEditor(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Sign in required' });
  if (!firebaseAdmin) return res.status(500).json({ error: 'Auth is not configured on this server' });
  let decoded;
  try {
    decoded = await firebaseAdmin.auth().verifyIdToken(match[1]);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired sign-in' });
  }
  const email = normalizeEmail(decoded.email);
  if (!email) return res.status(401).json({ error: 'Sign-in has no email' });
  if (!allowedEditors().has(email)) return res.status(403).json({ error: 'This account cannot edit Current Affairs content' });
  req.editorEmail = email;
  return next();
}

module.exports = { requireEditor, allowedEditors };
