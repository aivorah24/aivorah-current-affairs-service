// Feed collection, classification, credibility checks and de-duplication.
const crypto = require('crypto');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function cleanText(raw) {
  const unwrapped = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

// RSS 2.0 <item> and Atom <entry>. Returns [{ title, link, description, publishedAt }].
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => {
    let link = cleanText(tag(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? decodeEntities(href[1]) : '';
    }
    const date = cleanText(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'));
    const parsed = date ? new Date(date) : null;
    return {
      title: cleanText(tag(block, 'title')),
      link: link.trim(),
      description: cleanText(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')).slice(0, 2000),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    };
  }).filter((i) => i.title && i.link);
}

// ── Credibility: the link must be on the source's own site ──────────────────
function hostAllowed(link, allowedHosts) {
  let host;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return false; }
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// ── De-duplication ─────────────────────────────────────────────────────────
const TRACKING = /^(utm_|fbclid$|gclid$|ref$|cmp$|at_)/i;

function normalizeUrl(link) {
  try {
    const u = new URL(link);
    u.hash = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch {
    return String(link || '').trim().toLowerCase();
  }
}

function urlHash(link) {
  return crypto.createHash('sha256').update(normalizeUrl(link)).digest('hex');
}

function titleTokens(title) {
  return new Set(String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}

function similarTitles(a, b) {
  const ta = titleTokens(a); const tb = titleTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

// Removes repeats within the batch (same URL or near-identical title) and
// anything whose URL hash is already in ca_stories (`knownHashes`).
function dedupe(items, knownHashes = new Set()) {
  const kept = [];
  const dropped = [];
  const seen = new Set(knownHashes);
  for (const item of items) {
    const hash = item.hash || urlHash(item.link);
    if (seen.has(hash)) { dropped.push({ item, reason: knownHashes.has(hash) ? 'already in ca_stories' : 'duplicate url' }); continue; }
    const twin = kept.find((k) => similarTitles(k.title, item.title));
    if (twin) { dropped.push({ item, reason: `near-duplicate of "${twin.title}"` }); continue; }
    seen.add(hash);
    kept.push({ ...item, hash });
  }
  return { kept, dropped };
}

// ── Classification into the 7 categories ───────────────────────────────────
const KEYWORDS = {
  economy: ['economy', 'economic', 'inflation', 'gdp', 'bank', 'rupee', 'budget', 'trade', 'tax', 'market', 'export', 'import', 'monetary', 'repo rate', 'finance', 'investment', 'business'],
  science: ['space', 'satellite', 'rocket', 'isro', 'nasa', 'scientist', 'research', 'discovery', 'robot', 'artificial intelligence', ' ai ', 'technology', 'telescope', 'planet', 'moon', 'mars', 'physics', 'chemistry', 'vaccine trial', 'genome'],
  environment: ['climate', 'environment', 'wildlife', 'forest', 'pollution', 'tiger', 'species', 'ocean', 'emission', 'renewable', 'solar power', 'biodiversity', 'cyclone', 'flood', 'drought', 'heatwave', 'conservation'],
  sports: ['cricket', 'football', 'olympic', 'hockey', 'tennis', 'badminton', 'chess', 'athlete', 'medal', 'tournament', 'championship', 'world cup', 'paralympic'],
  society: ['school', 'education', 'student', 'health', 'hospital', 'heritage', 'culture', 'festival', 'unesco', 'children', 'disease', 'nutrition', 'literacy', 'museum', 'language'],
};

// The source's own category wins for subject-specific sources (RBI → economy,
// NASA → science). General news sources (India / World) are re-classified by
// keywords when a subject clearly dominates.
function classify(item, source) {
  if (!['india', 'world'].includes(source.category)) return source.category;
  const text = ` ${item.title} ${item.description} `.toLowerCase();
  let best = null; let bestScore = 0;
  for (const [category, words] of Object.entries(KEYWORDS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return bestScore >= 2 ? best : source.category;
}

// ── Child suitability ──────────────────────────────────────────────────────
// Items about violence, crime or tragedy are left out of a children's digest.
const UNSUITABLE = /\b(killed|kills|murder|rape|sexual|terror|terrorist|bomb|blast|shooting|shot dead|suicide|massacre|stabbed|beheaded|kidnap|abuse|porn|drugs? (?:bust|seized)|gang|lynch|riot|hostage|execution|war crimes?|casualt(?:y|ies)|death toll|dead bodies)\b/i;

function unsuitableReason(item) {
  const m = `${item.title} ${item.description}`.match(UNSUITABLE);
  return m ? `unsuitable for children ("${m[0]}")` : null;
}

// Higher = more worth covering: source credibility, then recency.
function rank(items, now = new Date()) {
  const score = (i) => {
    const ageHours = i.publishedAt ? (now - new Date(i.publishedAt)) / 3600000 : 36;
    return i.credibility * 10 - Math.min(48, Math.max(0, ageHours)) / 6;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

module.exports = {
  parseFeed, cleanText, hostAllowed, normalizeUrl, urlHash, similarTitles, dedupe, classify, unsuitableReason, rank,
};
