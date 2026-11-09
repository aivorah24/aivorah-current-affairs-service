// Digest Writer: turns one verified source item into 3 age versions, then
// checks the output against the source. Writing and checking are separate
// steps; nothing here publishes — rows are always status 'review'.

const AGE_SPECS = {
  young: { label: 'children aged 3-8', words: [50, 80], newWords: [1, 1],
    style: 'very simple English, short sentences, friendly tone; explain what happened and why it matters' },
  kid: { label: 'children aged 8-12', words: [80, 120], newWords: [2, 2],
    style: 'intermediate English; explain what happened and why it matters' },
  teen: { label: 'teenagers aged 13 and over', words: [120, 180], newWords: [2, 3],
    style: 'intermediate-to-advanced English; explain what happened, why it matters and its wider impact' },
};

const FIELDS = ['title', 'summary', 'whatHappened', 'whyImportant', 'didYouKnow', 'thinkAboutIt'];

function storyPrompt(item) {
  const versions = Object.entries(AGE_SPECS).map(([key, s]) =>
    `- "${key}": for ${s.label}. ${s.style}. whatHappened + whyImportant together ${s.words[0]}-${s.words[1]} words. ` +
    `${s.newWords[0] === s.newWords[1] ? s.newWords[0] : `${s.newWords[0]}-${s.newWords[1]}`} new word(s).`).join('\n');
  return [
    {
      role: 'system',
      content: [
        'You write a daily current-affairs digest for school children in India.',
        'Rules:',
        '1. Use ONLY facts stated in the SOURCE. Never add names, numbers, dates, places or claims that are not in it.',
        '2. Neutral and factual: no opinions, no political slant, no fear-inducing language.',
        '3. "didYouKnow" is one well-known, uncontroversial related fact (an editor will check it).',
        '4. "thinkAboutIt" is one open question that makes the child reflect.',
        '5. "summary" is one sentence for the story card. "title" is short.',
        '6. Each new word comes with a child-friendly definition.',
        '7. If the source is not suitable for children, or has too little information, reply {"skip": true, "reason": "..."}.',
        'Reply with JSON only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `SOURCE (${item.sourceName}, ${item.link}):`,
        `Title: ${item.title}`,
        `Text: ${item.description || '(headline only)'}`,
        '',
        `Category: ${item.category}`,
        'Write three versions:',
        versions,
        '',
        'JSON shape:',
        '{"young": {"title": "", "summary": "", "whatHappened": "", "whyImportant": "", "didYouKnow": "", ' +
          '"newWords": [{"word": "", "definition": ""}], "thinkAboutIt": ""}, "kid": {...same...}, "teen": {...same...}}',
      ].join('\n'),
    },
  ];
}

const words = (text) => String(text || '').split(/\s+/).filter(Boolean).length;

// Structural problems reject the item; soft problems become review flags.
function validateStory(data) {
  const errors = [];
  const flags = [];
  for (const [key, spec] of Object.entries(AGE_SPECS)) {
    const v = data?.[key];
    if (!v || typeof v !== 'object') { errors.push(`missing "${key}" version`); continue; }
    for (const f of FIELDS) if (!String(v[f] || '').trim()) errors.push(`${key}.${f} is empty`);
    const list = Array.isArray(v.newWords) ? v.newWords.filter((w) => w?.word && w?.definition) : [];
    if (!list.length) errors.push(`${key}.newWords is empty`);
    else if (list.length < spec.newWords[0] || list.length > spec.newWords[1]) {
      flags.push(`${key}: ${list.length} new words (expected ${spec.newWords.join('-')})`);
    }
    const n = words(v.whatHappened) + words(v.whyImportant);
    if (n < spec.words[0] * 0.85 || n > spec.words[1] * 1.15) {
      flags.push(`${key}: ${n} words (expected ${spec.words[0]}-${spec.words[1]})`);
    }
  }
  return { errors, flags };
}

const COMMON_CAPS = new Set(['I', 'A', 'The', 'This', 'That', 'These', 'Those', 'It', 'In', 'On', 'At', 'For', 'And', 'But', 'If',
  'When', 'Why', 'What', 'How', 'Who', 'Did', 'Do', 'You', 'We', 'They', 'He', 'She', 'Our', 'Your', 'Its', 'Their', 'Some',
  'Many', 'Now', 'Today', 'Earth', 'Imagine', 'Think', 'Can', 'Could', 'Would', 'Should', 'Scientists', 'People', 'India',
  'Indian', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'English']);

// Fact check against the source: every number and proper name in the
// generated text (except "did you know", which is checked by the editor)
// should appear in the source text. Anything else is flagged for review.
function verifyAgainstSource(data, item) {
  const source = `${item.title} ${item.description}`;
  const sourceNumbers = new Set((source.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]+$/, '').replace(/,/g, '')));
  const sourceLower = source.toLowerCase();
  const badNumbers = new Set();
  const badNames = new Set();

  for (const key of Object.keys(AGE_SPECS)) {
    const v = data[key] || {};
    const text = [v.title, v.summary, v.whatHappened, v.whyImportant].join(' ');
    for (const raw of text.match(/\d[\d,.]*/g) || []) {
      const n = raw.replace(/[,.]+$/, '').replace(/,/g, '');
      if (!sourceNumbers.has(n)) badNumbers.add(n);
    }
    for (const m of text.matchAll(/(?<=[a-z,;:]\s)([A-Z][a-zA-Z-]{2,})/g)) {
      const name = m[1];
      if (!COMMON_CAPS.has(name) && !sourceLower.includes(name.toLowerCase())) badNames.add(name);
    }
  }

  const flags = [];
  if (badNumbers.size) flags.push(`numbers not in source: ${[...badNumbers].slice(0, 8).join(', ')}`);
  if (badNames.size) flags.push(`names not in source: ${[...badNames].slice(0, 8).join(', ')}`);
  if (!item.description || words(item.description) < 15) flags.push('source had little text — check the full article');
  flags.push('did-you-know facts need a source check');
  return flags;
}

function cleanWords(list) {
  return (Array.isArray(list) ? list : [])
    .filter((w) => w?.word && w?.definition)
    .map((w) => ({ word: String(w.word).trim(), definition: String(w.definition).trim() }));
}

// Generated JSON + source item → a ca_stories row, always waiting for review.
function toStoryRow(data, item, { publishDate, flags }) {
  const kidWords = cleanWords(data.kid.newWords);
  const teenExtra = cleanWords(data.teen.newWords).filter((w) => !kidWords.some((k) => k.word.toLowerCase() === w.word.toLowerCase()));
  const shared = [...kidWords, ...teenExtra].slice(0, 3);
  const extras = {};
  for (const key of Object.keys(AGE_SPECS)) {
    extras[key] = {
      didYouKnow: data[key].didYouKnow,
      thinkAboutIt: data[key].thinkAboutIt,
      newWords: cleanWords(data[key].newWords).slice(0, AGE_SPECS[key].newWords[1]),
    };
  }
  return {
    category: item.category,
    publish_date: publishDate,
    status: 'review',
    is_true_fact: false,
    priority: item.credibility * 10,
    title_young: data.young.title, title_kid: data.kid.title, title_teen: data.teen.title,
    summary_young: data.young.summary, summary_kid: data.kid.summary, summary_teen: data.teen.summary,
    what_happened_young: data.young.whatHappened, what_happened_kid: data.kid.whatHappened, what_happened_teen: data.teen.whatHappened,
    why_important_young: data.young.whyImportant, why_important_kid: data.kid.whyImportant, why_important_teen: data.teen.whyImportant,
    did_you_know: data.kid.didYouKnow,
    think_about_it: data.kid.thinkAboutIt,
    new_word_1: shared[0]?.word || null, def_1: shared[0]?.definition || null,
    new_word_2: shared[1]?.word || null, def_2: shared[1]?.definition || null,
    new_word_3: shared[2]?.word || null, def_3: shared[2]?.definition || null,
    age_extras: extras,
    image_url: null,
    source: item.sourceName,
    source_url: item.link,
    source_url_hash: item.hash,
    review_notes: flags.length ? flags.join('\n') : null,
  };
}

module.exports = { AGE_SPECS, storyPrompt, validateStory, verifyAgainstSource, toStoryRow };
