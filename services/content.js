// Age groups, categories, dates and the story shape the app receives.
// Pure functions only — no database access — so they are easy to test.

const AGE_GROUPS = {
  // Spec: 5-7 stories a day, about 5 minutes of reading.
  'under-8': { column: 'young', storiesPerDay: 5, newWords: 1, wordsPerMinute: 90 },
  '8-12':    { column: 'kid',   storiesPerDay: 6, newWords: 2, wordsPerMinute: 130 },
  '13+':     { column: 'teen',  storiesPerDay: 7, newWords: 3, wordsPerMinute: 170 },
};

const CATEGORIES = ['india', 'world', 'economy', 'science', 'environment', 'sports', 'society'];

const ALIASES = {
  'under-8': 'under-8', under8: 'under-8', '3-8': 'under-8', young: 'under-8',
  '8-12': '8-12', kid: '8-12',
  '13+': '13+', '13': '13+', teen: '13+',
};

// "13+" in a query string arrives as "13 " (a raw "+" decodes to a space), so trim first.
function normalizeAgeGroup(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return ALIASES[key] || null;
}

// ── Dates ───────────────────────────────────────────────────────────────────
// Students are in India, so "today" is the Asia/Kolkata calendar day, not UTC.
const TIME_ZONE = process.env.CA_TIME_ZONE || 'Asia/Kolkata';

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function isDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

// The weekly quiz is released on Sunday and played until Saturday:
// its week_start is the most recent Sunday on or before the date.
function quizWeekStart(dateStr) {
  return addDays(dateStr, -new Date(`${dateStr}T00:00:00Z`).getUTCDay());
}

// ── Stories ─────────────────────────────────────────────────────────────────
function wordCount(...texts) {
  return texts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
}

// Seconds, rounded to 5, kept within 30s-3min.
function readTimeSeconds(words, ageGroup) {
  const wpm = AGE_GROUPS[ageGroup].wordsPerMinute;
  const secs = Math.round(((words / wpm) * 60) / 5) * 5;
  return Math.min(180, Math.max(30, secs));
}

function wordsFor(row, ageGroup) {
  const extras = row.age_extras?.[AGE_GROUPS[ageGroup].column];
  const list = Array.isArray(extras?.newWords) && extras.newWords.length
    ? extras.newWords
    : [
      { word: row.new_word_1, definition: row.def_1 },
      { word: row.new_word_2, definition: row.def_2 },
      { word: row.new_word_3, definition: row.def_3 },
    ];
  return list
    .filter((w) => w && w.word && w.definition)
    .slice(0, AGE_GROUPS[ageGroup].newWords)
    .map((w) => ({ word: String(w.word), definition: String(w.definition) }));
}

// A ca_stories row → the app's Story for one age group.
function toStory(row, ageGroup) {
  const col = AGE_GROUPS[ageGroup].column;
  const extras = row.age_extras?.[col] || {};
  const story = {
    id: row.id,
    category: row.category,
    publishDate: row.publish_date,
    title: row[`title_${col}`],
    summary: row[`summary_${col}`],
    whatHappened: row[`what_happened_${col}`],
    whyImportant: row[`why_important_${col}`],
    didYouKnow: extras.didYouKnow || row.did_you_know || null,
    newWords: wordsFor(row, ageGroup),
    thinkAboutIt: extras.thinkAboutIt || row.think_about_it || null,
    imageUrl: row.image_url || null,
    source: row.source,
    sourceUrl: row.source_url || null,
  };
  story.readTimeSeconds = readTimeSeconds(
    wordCount(story.title, story.whatHappened, story.whyImportant, story.didYouKnow, story.thinkAboutIt,
      ...story.newWords.map((w) => `${w.word} ${w.definition}`)),
    ageGroup,
  );
  return story;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID.test(String(value || ''));

module.exports = {
  AGE_GROUPS, CATEGORIES, normalizeAgeGroup,
  localDate, isDateString, addDays, daysBetween, quizWeekStart,
  toStory, readTimeSeconds, isUuid,
};
