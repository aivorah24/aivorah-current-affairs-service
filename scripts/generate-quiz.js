#!/usr/bin/env node
// Weekly Quiz Generator (PRD §6.3). Run on Sunday: writes 10 questions per age
// group from the stories PUBLISHED in the previous 7 days, into
// ca_quiz_questions with status 'review'. Never publishes — an editor does.
//
// Composition: 2 each from India / World / Science / Economy+Environment /
// Sports+Society; 6 mcq, 2 true_false, 2 reasoning. When a group has no
// stories that week the writer may substitute, and the gap is flagged.
//
// Usage:
//   node scripts/generate-quiz.js [--dry-run] [--week=YYYY-MM-DD (a Sunday)] [--age=8-12] [--force]
require('dotenv').config();

const { AGE_GROUPS, CATEGORIES, localDate, isDateString, addDays, quizWeekStart, toStory } = require('../services/content');
const { CATEGORY_SLOTS, TYPE_QUOTA, QUIZ_SIZE } = require('../services/quiz');
const { completeJSON } = require('./lib/llm');
const { createLogger } = require('./lib/log');

function parseArgs(argv) {
  const args = { dryRun: false, week: null, ages: Object.keys(AGE_GROUPS), force: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a.startsWith('--week=')) args.week = a.slice(7);
    else if (a.startsWith('--age=')) args.ages = [a.slice(6)];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.week && (!isDateString(args.week) || quizWeekStart(args.week) !== args.week)) throw new Error('--week must be a Sunday, YYYY-MM-DD');
  for (const age of args.ages) if (!AGE_GROUPS[age]) throw new Error(`--age must be one of ${Object.keys(AGE_GROUPS).join(', ')}`);
  return args;
}

const DIFFICULTY = {
  'under-8': 'basic knowledge, very simple words, short questions',
  '8-12': 'knowledge plus simple reasoning',
  '13+': 'knowledge plus reasoning about causes and impact',
};

function quizPrompt(stories, ageGroup) {
  const list = stories.map((s) => `- id ${s.id} [${s.category}] ${s.title}: ${s.whatHappened} ${s.whyImportant}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        `You write a weekly current-affairs quiz for ${ageGroup === '13+' ? 'teenagers (13+)' : `children aged ${ageGroup}`}. Difficulty: ${DIFFICULTY[ageGroup]}.`,
        'Every question must be answerable from the STORIES given. Never use facts that are not in them.',
        `Exactly ${QUIZ_SIZE} questions: 2 India, 2 World, 2 Science, 2 Economy or Environment, 2 Sports or Society.`,
        'If a group has no story, use another group and say so in "note".',
        'Types: 6 "mcq" (4 options), 2 "true_false" (options exactly ["True", "False"]), 2 "reasoning" (4 options; asks why or what would happen).',
        'Each question: "explanation" (why the answer is right, 1-2 sentences) and "extraFact" (one more fact FROM THE STORY).',
        'Reply with JSON only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'STORIES:', list, '',
        'JSON shape: {"questions": [{"storyId": "", "category": "", "type": "mcq|true_false|reasoning", "question": "", ' +
          '"options": ["", "", "", ""], "correctIndex": 0, "explanation": "", "extraFact": ""}], "note": ""}',
      ].join('\n'),
    },
  ];
}

// Hard errors reject the set; composition gaps are flags for the editor.
function validateQuiz(data, storyIds) {
  const errors = [];
  const flags = [];
  const qs = Array.isArray(data?.questions) ? data.questions : [];
  if (qs.length !== QUIZ_SIZE) errors.push(`expected ${QUIZ_SIZE} questions, got ${qs.length}`);
  qs.forEach((q, i) => {
    const n = i + 1;
    if (!String(q?.question || '').trim()) errors.push(`Q${n}: empty question`);
    if (!CATEGORIES.includes(q?.category)) errors.push(`Q${n}: unknown category "${q?.category}"`);
    if (!TYPE_QUOTA[q?.type]) errors.push(`Q${n}: unknown type "${q?.type}"`);
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (q?.type === 'true_false' && !(opts.length === 2 && opts[0] === 'True' && opts[1] === 'False')) errors.push(`Q${n}: true_false options must be ["True", "False"]`);
    if (q?.type !== 'true_false' && (opts.length !== 4 || opts.some((o) => !String(o || '').trim()))) errors.push(`Q${n}: needs 4 options`);
    if (!Number.isInteger(q?.correctIndex) || q.correctIndex < 0 || q.correctIndex >= opts.length) errors.push(`Q${n}: correctIndex out of range`);
    if (!String(q?.explanation || '').trim()) errors.push(`Q${n}: missing explanation`);
    if (q?.storyId && !storyIds.has(q.storyId)) flags.push(`Q${n}: storyId not in this week's stories — removed`);
  });
  const types = qs.reduce((acc, q) => ({ ...acc, [q?.type]: (acc[q?.type] || 0) + 1 }), {});
  for (const [type, want] of Object.entries(TYPE_QUOTA)) {
    if ((types[type] || 0) !== want) flags.push(`${types[type] || 0} ${type} questions (expected ${want})`);
  }
  for (const cats of CATEGORY_SLOTS) {
    const have = qs.filter((q) => cats.includes(q?.category)).length;
    if (have !== 2) flags.push(`${have} questions for ${cats.join('/')} (expected 2)`);
  }
  if (data?.note) flags.push(`writer note: ${data.note}`);
  return { errors, flags };
}

function toQuestionRows(data, { weekStart, ageGroup, storyIds }) {
  return data.questions.map((q, i) => ({
    week_start: weekStart,
    age_group: ageGroup,
    category: q.category,
    question_type: q.type,
    question: String(q.question).trim(),
    options: q.options.map((o) => String(o).trim()),
    correct_index: q.correctIndex,
    explanation: String(q.explanation).trim(),
    extra_fact: q.extraFact ? String(q.extraFact).trim() : null,
    story_id: q.storyId && storyIds.has(q.storyId) ? q.storyId : null,
    status: 'review',
    position: i + 1,
  }));
}

async function runQuizPipeline({ week, ages = Object.keys(AGE_GROUPS), dryRun = false, force = false, supabase, llm = completeJSON, now = new Date(), logger }) {
  const weekStart = week || quizWeekStart(localDate(now));
  const { log } = logger || createLogger('generate-quiz', weekStart);
  const from = addDays(weekStart, -7);
  const to = addDays(weekStart, -1);
  log('start', { message: `quiz for week ${weekStart} from stories ${from}..${to}${dryRun ? ' (dry run)' : ''}` });

  const { data: rows, error } = await supabase.from('ca_stories').select('*')
    .eq('status', 'published').gte('publish_date', from).lte('publish_date', to);
  if (error) throw new Error(`Could not load stories: ${error.message}`);
  if (!rows?.length) {
    log('no_stories', { message: 'no published stories last week — nothing to do' });
    return { weekStart, results: [] };
  }

  const results = [];
  for (const ageGroup of ages) {
    if (!force) {
      const { data: existing, error: exErr } = await supabase.from('ca_quiz_questions').select('id')
        .eq('week_start', weekStart).eq('age_group', ageGroup).limit(1);
      if (exErr) throw new Error(exErr.message);
      if (existing?.length) { log('exists', { ageGroup, message: `${ageGroup}: questions already exist (use --force)` }); continue; }
    }
    const stories = rows.map((r) => toStory(r, ageGroup));
    const storyIds = new Set(stories.map((s) => s.id));

    let accepted = null;
    for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
      try {
        const { data, model } = await llm(quizPrompt(stories, ageGroup));
        const { errors, flags } = validateQuiz(data, storyIds);
        if (errors.length) { log('invalid_output', { ageGroup, attempt, errors }); continue; }
        accepted = { rows: toQuestionRows(data, { weekStart, ageGroup, storyIds }), flags, model };
      } catch (e) {
        log('generation_failed', { ageGroup, attempt, message: e.message });
      }
    }
    if (!accepted) { results.push({ ageGroup, saved: 0, failed: true }); continue; }

    if (dryRun) {
      log('dry_run_quiz', { ageGroup, flags: accepted.flags, rows: accepted.rows });
      results.push({ ageGroup, saved: 0, rows: accepted.rows, flags: accepted.flags });
      continue;
    }
    const { error: insErr } = await supabase.from('ca_quiz_questions').insert(accepted.rows);
    if (insErr) { log('save_failed', { ageGroup, message: insErr.message }); results.push({ ageGroup, saved: 0, failed: true }); continue; }
    log('saved_for_review', { ageGroup, count: accepted.rows.length, model: accepted.model, flags: accepted.flags });
    results.push({ ageGroup, saved: accepted.rows.length, flags: accepted.flags });
  }
  log('done', { message: results.map((r) => `${r.ageGroup}: ${r.failed ? 'failed' : `${r.saved} saved`}`).join(', ') });
  return { weekStart, results };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const supabase = require('../services/supabase');
    const { results } = await runQuizPipeline({ week: args.week, ages: args.ages, dryRun: args.dryRun, force: args.force, supabase });
    process.exit(results.some((r) => r.failed) ? 1 : 0);
  })().catch((e) => {
    console.error(`[generate-quiz] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { runQuizPipeline, validateQuiz, quizPrompt, parseArgs };
