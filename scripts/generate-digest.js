#!/usr/bin/env node
// Daily content pipeline (PRD §6.2):
//   1. Collect   — RSS from the approved sources in scripts/lib/sources.js only
//   2. Classify  — into the 7 categories; drop items unsuitable for children
//   3. Verify    — link must be on the source's own site; de-dupe by URL hash
//                  (against this batch and ca_stories) and near-identical titles;
//                  rank by source credibility + recency
//   4. Write     — LLM (Groq) writes the under-8 / 8-12 / 13+ versions
//   5. Check     — structure + word counts, and numbers/names against the source;
//                  problems become review notes for the editor
//   6. Save      — insert into ca_stories with status 'review'. NEVER publishes:
//                  an editor sets status = 'published' (see SETUP.md).
//
// Usage:
//   node scripts/generate-digest.js [--dry-run] [--date=YYYY-MM-DD] [--max=25] [--per-category=4]
// --dry-run fetches and writes but saves nothing (output goes to the log file).
require('dotenv').config();

const { SOURCES, enabledSources } = require('./lib/sources');
const { parseFeed, hostAllowed, urlHash, dedupe, classify, unsuitableReason, rank } = require('./lib/feeds');
const { storyPrompt, validateStory, verifyAgainstSource, toStoryRow } = require('./lib/writer');
const { completeJSON } = require('./lib/llm');
const { createLogger } = require('./lib/log');
const { localDate, isDateString } = require('../services/content');

const USER_AGENT = 'AivorahCurrentAffairsBot/1.0';
const MAX_ITEM_AGE_HOURS = 48;

function parseArgs(argv) {
  const args = { dryRun: false, date: null, max: 25, perCategory: 4 };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--date=')) args.date = a.slice(7);
    else if (a.startsWith('--max=')) args.max = parseInt(a.slice(6), 10);
    else if (a.startsWith('--per-category=')) args.perCategory = parseInt(a.slice(15), 10);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.date && !isDateString(args.date)) throw new Error('--date must be YYYY-MM-DD');
  if (!(args.max > 0) || !(args.perCategory > 0)) throw new Error('--max and --per-category must be positive numbers');
  return args;
}

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2000))) throw new Error('response is not an RSS/Atom feed');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// 1-3: collect, verify host, classify, filter, de-dupe, rank.
async function collect({ sources, fetchImpl, now, log, knownHashesFor }) {
  const items = [];
  for (const source of sources) {
    let xml;
    try {
      xml = await fetchText(source.url, fetchImpl);
    } catch (e) {
      log('source_failed', { source: source.id, message: `${source.name}: ${e.message}` });
      continue;
    }
    const parsed = parseFeed(xml);
    let kept = 0;
    for (const entry of parsed) {
      if (!hostAllowed(entry.link, source.allowedHosts)) {
        log('rejected', { source: source.id, link: entry.link, reason: 'link is not on the source\'s own site' });
        continue;
      }
      if (entry.publishedAt && now - new Date(entry.publishedAt) > MAX_ITEM_AGE_HOURS * 3600000) continue;
      const item = { ...entry, sourceId: source.id, sourceName: source.name, credibility: source.credibility };
      const unsuitable = unsuitableReason(item);
      if (unsuitable) { log('rejected', { source: source.id, link: item.link, reason: unsuitable, message: unsuitable }); continue; }
      item.category = classify(item, source);
      item.hash = urlHash(item.link);
      items.push(item);
      kept++;
    }
    log('collected', { source: source.id, message: `${source.name}: ${parsed.length} items, ${kept} kept` });
  }

  const known = await knownHashesFor(items.map((i) => i.hash));
  const { kept, dropped } = dedupe(rank(items, now), known);
  for (const d of dropped) log('deduplicated', { link: d.item.link, reason: d.reason });
  return kept;
}

// Up to `perCategory` per category and `max` in total, best-ranked first,
// taking one from each category in turn so every category gets covered.
function selectForToday(items, { max, perCategory }) {
  const byCat = new Map();
  for (const i of items) {
    if (!byCat.has(i.category)) byCat.set(i.category, []);
    byCat.get(i.category).push(i);
  }
  const picked = [];
  for (let round = 0; round < perCategory && picked.length < max; round++) {
    for (const list of byCat.values()) {
      if (list[round] && picked.length < max) picked.push(list[round]);
    }
  }
  return picked;
}

async function runDigestPipeline({
  date, dryRun = false, max = 25, perCategory = 4,
  sources = enabledSources(SOURCES), fetchImpl = fetch, supabase, llm = completeJSON,
  now = new Date(), logger,
}) {
  const publishDate = date || localDate(now);
  const { log } = logger || createLogger('generate-digest', publishDate);
  log('start', { message: `digest for ${publishDate}${dryRun ? ' (dry run)' : ''}`, sources: sources.map((s) => s.id) });

  const knownHashesFor = async (hashes) => {
    if (!supabase || !hashes.length) return new Set();
    const { data, error } = await supabase.from('ca_stories').select('source_url_hash').in('source_url_hash', hashes);
    if (error) throw new Error(`Could not check existing stories: ${error.message}`);
    return new Set((data || []).map((r) => r.source_url_hash));
  };

  const candidates = await collect({ sources, fetchImpl, now, log, knownHashesFor });
  const chosen = selectForToday(candidates, { max, perCategory });
  log('selected', { message: `${chosen.length} of ${candidates.length} candidates`, links: chosen.map((c) => c.link) });

  const summary = { date: publishDate, dryRun, candidates: candidates.length, saved: 0, skipped: 0, failed: 0, rows: [] };
  for (const item of chosen) {
    let generated;
    try {
      generated = await llm(storyPrompt(item));
    } catch (e) {
      summary.failed++;
      log('generation_failed', { link: item.link, message: e.message });
      continue;
    }
    const data = generated?.data;
    if (data?.skip) {
      summary.skipped++;
      log('skipped_by_writer', { link: item.link, reason: data.reason || 'not suitable' });
      continue;
    }
    const { errors, flags } = validateStory(data);
    if (errors.length) {
      summary.failed++;
      log('invalid_output', { link: item.link, errors });
      continue;
    }
    const allFlags = [...flags, ...verifyAgainstSource(data, item)];
    const row = toStoryRow(data, item, { publishDate, flags: allFlags });
    summary.rows.push(row);

    if (dryRun) {
      log('dry_run_story', { link: item.link, model: generated.model, flags: allFlags, row });
      continue;
    }
    const { error } = await supabase.from('ca_stories').insert(row);
    if (error) {
      if (error.code === '23505') { summary.skipped++; log('deduplicated', { link: item.link, reason: 'saved by another run' }); continue; }
      summary.failed++;
      log('save_failed', { link: item.link, message: error.message });
      continue;
    }
    summary.saved++;
    log('saved_for_review', { link: item.link, category: row.category, model: generated.model, flags: allFlags });
  }

  log('done', { message: `saved ${summary.saved} for review, skipped ${summary.skipped}, failed ${summary.failed}` });
  return summary;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const supabase = args.dryRun ? null : require('../services/supabase');
    const summary = await runDigestPipeline({ ...args, supabase });
    console.log(`\nDone: ${summary.saved} stories saved with status 'review'. Publish them after checking (SETUP.md → "Reviewing content").`);
    process.exit(summary.failed && !summary.saved && !summary.dryRun ? 1 : 0);
  })().catch((e) => {
    console.error(`[generate-digest] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { runDigestPipeline, selectForToday, parseArgs };
