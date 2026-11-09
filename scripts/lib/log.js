// Action log: every step is printed and appended as JSON lines to
// logs/<name>-YYYY-MM-DD.jsonl (logs/ is git-ignored).
const fs = require('fs');
const path = require('path');

function createLogger(name, date, { dir = path.join(__dirname, '..', '..', 'logs'), quiet = false } = {}) {
  const file = path.join(dir, `${name}-${date}.jsonl`);
  const entries = [];
  let writable = true;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { writable = false; }

  function log(action, details = {}) {
    const entry = { at: new Date().toISOString(), action, ...details };
    entries.push(entry);
    if (!quiet) console.log(`[${name}] ${action}${details.message ? ` — ${details.message}` : ''}`);
    if (writable) {
      try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`); } catch { writable = false; }
    }
  }
  return { log, entries, file };
}

module.exports = { createLogger };
