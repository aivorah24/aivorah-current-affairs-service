const crypto = require('crypto');

// Only Date is faked — supertest needs real timers and nextTick.
function freezeTime(iso) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
}

function storyRow(overrides = {}) {
  const n = overrides.n ?? 1;
  return {
    id: crypto.randomUUID(),
    category: 'india',
    publish_date: '2026-11-09',
    status: 'published',
    priority: 0,
    title_young: `Young title ${n}`, title_kid: `Kid title ${n}`, title_teen: `Teen title ${n}`,
    summary_young: 'Young summary', summary_kid: 'Kid summary', summary_teen: 'Teen summary',
    what_happened_young: 'Something happened.', what_happened_kid: 'Something happened in detail.',
    what_happened_teen: 'Something happened in much more detail for teens.',
    why_important_young: 'It matters.', why_important_kid: 'It matters because.', why_important_teen: 'It matters because of impact.',
    did_you_know: 'A fact.',
    new_word_1: 'Rover', def_1: 'A vehicle that explores.',
    new_word_2: 'Lunar', def_2: 'About the Moon.',
    new_word_3: 'Orbit', def_3: 'A path around a planet.',
    think_about_it: 'What do you think?',
    age_extras: {},
    image_url: null,
    source: 'ISRO',
    source_url: 'https://www.isro.gov.in/x',
    created_at: `2026-11-09T00:00:0${n % 10}Z`,
    ...overrides,
  };
}

// The PRD mix: 2 per category group, 6 mcq / 2 true_false / 2 reasoning.
const WEEK_PLAN = [
  ['india', 'mcq'], ['india', 'true_false'],
  ['world', 'mcq'], ['world', 'reasoning'],
  ['science', 'mcq'], ['science', 'true_false'],
  ['economy', 'mcq'], ['environment', 'mcq'],
  ['sports', 'mcq'], ['society', 'reasoning'],
];

function questionRow(overrides = {}) {
  const type = overrides.question_type || 'mcq';
  return {
    id: crypto.randomUUID(),
    week_start: '2026-11-08',
    age_group: '8-12',
    category: 'india',
    question_type: type,
    question: 'Question?',
    options: type === 'true_false' ? ['True', 'False'] : ['A', 'B', 'C', 'D'],
    correct_index: 1,
    explanation: 'Because.',
    extra_fact: 'Extra fact.',
    story_id: null,
    status: 'published',
    position: 0,
    ...overrides,
  };
}

function weekQuestions(overrides = {}) {
  return WEEK_PLAN.map(([category, question_type], i) =>
    questionRow({ category, question_type, position: i + 1, question: `Q${i + 1}`, ...overrides }));
}

const auth = (email) => ({ Authorization: `Bearer token-for:${email}` });

module.exports = { freezeTime, storyRow, questionRow, weekQuestions, WEEK_PLAN, auth };
