// Content pipeline: feed parsing, credibility, de-dupe, classification, the
// fact check, and end-to-end runs with fake feeds, a fake LLM and the
// in-memory Supabase. Stories and quizzes with no fact-check problems are
// published by themselves; anything else waits for an editor (status 'review').
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { parseFeed, hostAllowed, normalizeUrl, urlHash, dedupe, classify, unsuitableReason } = require('../scripts/lib/feeds');
const { validateStory, verifyAgainstSource } = require('../scripts/lib/writer');
const { extractJSON } = require('../scripts/lib/llm');
const { runDigestPipeline, selectForToday, parseArgs } = require('../scripts/generate-digest');
const { runQuizPipeline, validateQuiz } = require('../scripts/generate-quiz');
const { SOURCES, enabledSources } = require('../scripts/lib/sources');
const { storyRow, WEEK_PLAN } = require('./helpers/fixtures');

const NOW = new Date('2026-11-09T02:00:00Z');
const quietLogger = () => { const entries = []; return { entries, log: (action, d = {}) => entries.push({ action, ...d }) }; };

const rss = (items) => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.map((i) => `
  <item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>
  <description>${i.description || ''}</description><pubDate>${i.date || 'Mon, 09 Nov 2026 00:30:00 GMT'}</pubDate></item>`).join('')}
</channel></rss>`;

const PIB = { id: 'pib', name: 'PIB', category: 'india', credibility: 3, enabled: true, url: 'https://pib.gov.in/rss', allowedHosts: ['pib.gov.in'] };
const NASA = { id: 'nasa', name: 'NASA', category: 'science', credibility: 3, enabled: true, url: 'https://www.nasa.gov/feed/', allowedHosts: ['nasa.gov'] };

function version(n) {
  const filler = (count) => Array.from({ length: count }, () => 'word').join(' ');
  return {
    title: 'ISRO launches a new satellite', summary: 'ISRO launched a weather satellite.',
    whatHappened: `ISRO launched a weather satellite called Meghdoot. ${filler(n.what)}`,
    whyImportant: `It will help forecast rain. ${filler(n.why)}`,
    didYouKnow: 'India launched its first satellite, Aryabhata, in 1975.',
    newWords: n.words, thinkAboutIt: 'How does weather news help farmers?',
  };
}
const word = (w) => ({ word: w, definition: `Meaning of ${w}.` });
const GOOD_STORY = {
  young: version({ what: 30, why: 25, words: [word('Satellite')] }),
  kid: version({ what: 50, why: 40, words: [word('Satellite'), word('Forecast')] }),
  teen: version({ what: 80, why: 60, words: [word('Satellite'), word('Forecast'), word('Orbit')] }),
};

describe('feeds', () => {
  test('parses RSS items and Atom entries, unwrapping CDATA, entities and HTML', () => {
    const items = parseFeed(rss([{ title: 'A &amp; B', link: 'https://pib.gov.in/a', description: '<p>Hello <b>world</b></p>' }]));
    expect(items).toEqual([{ title: 'A & B', link: 'https://pib.gov.in/a', description: 'Hello world', publishedAt: '2026-11-09T00:30:00.000Z' }]);

    const atom = parseFeed('<feed><entry><title>Atom title</title><link href="https://www.nasa.gov/x"/><summary>Sum</summary><updated>2026-11-08T10:00:00Z</updated></entry></feed>');
    expect(atom[0]).toMatchObject({ title: 'Atom title', link: 'https://www.nasa.gov/x', description: 'Sum' });
  });

  test("only links on the source's own site are credible", () => {
    expect(hostAllowed('https://www.pib.gov.in/x', ['pib.gov.in'])).toBe(true);
    expect(hostAllowed('https://pib.gov.in.evil.com/x', ['pib.gov.in'])).toBe(false);
    expect(hostAllowed('not a url', ['pib.gov.in'])).toBe(false);
  });

  test('URL hashes ignore tracking params, www, fragments and trailing slashes', () => {
    expect(normalizeUrl('http://www.BBC.co.uk/news/1/?utm_source=x&b=2&a=1#top')).toBe('https://bbc.co.uk/news/1?a=1&b=2');
    expect(urlHash('https://bbc.co.uk/news/1')).toBe(urlHash('https://www.bbc.co.uk/news/1/?utm_medium=rss'));
  });

  test('de-dupes repeated URLs, near-identical titles and stories already saved', () => {
    const items = [
      { title: 'India launches weather satellite Meghdoot today', link: 'https://pib.gov.in/1' },
      { title: 'India launches weather satellite Meghdoot today', link: 'https://pib.gov.in/1?utm_source=a' },
      { title: 'India launches the weather satellite Meghdoot', link: 'https://pib.gov.in/2' },
      { title: 'RBI keeps repo rate unchanged', link: 'https://rbi.org.in/3' },
      { title: 'Something old', link: 'https://pib.gov.in/old' },
    ];
    const { kept, dropped } = dedupe(items, new Set([urlHash('https://pib.gov.in/old')]));
    expect(kept.map((k) => k.link)).toEqual(['https://pib.gov.in/1', 'https://rbi.org.in/3']);
    expect(dropped.map((d) => d.reason)).toEqual(['duplicate url', expect.stringMatching(/near-duplicate/), 'already in ca_stories']);
  });

  test('general sources are re-classified by subject; subject sources keep theirs', () => {
    expect(classify({ title: 'India wins cricket world cup', description: 'The team won the tournament' }, PIB)).toBe('sports');
    expect(classify({ title: 'Cabinet approves new policy', description: '' }, PIB)).toBe('india');
    expect(classify({ title: 'Cricket on the Moon?', description: 'tournament' }, NASA)).toBe('science');
  });

  test('violent or distressing items are left out', () => {
    expect(unsuitableReason({ title: 'Five killed in blast', description: '' })).toMatch(/unsuitable/);
    expect(unsuitableReason({ title: 'New tiger reserve opens', description: '' })).toBeNull();
  });

  test('selection takes categories in turn within the limits', () => {
    const items = [
      { category: 'india', link: 1 }, { category: 'india', link: 2 }, { category: 'india', link: 3 },
      { category: 'science', link: 4 }, { category: 'world', link: 5 },
    ];
    expect(selectForToday(items, { max: 4, perCategory: 2 }).map((i) => i.link)).toEqual([1, 4, 5, 2]);
  });

  test('every enabled source has a URL and allowed hosts; Reuters/AP stay off without a licence', () => {
    for (const s of enabledSources(SOURCES)) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.allowedHosts.length).toBeGreaterThan(0);
    }
    expect(SOURCES.find((s) => s.id === 'reuters').enabled).toBe(false);
    expect(SOURCES.find((s) => s.id === 'ap').enabled).toBe(false);
  });
});

describe('writer checks', () => {
  test('a well-formed story passes; missing fields are errors, off-length text is a flag', () => {
    expect(validateStory(GOOD_STORY)).toEqual({ errors: [], flags: [] });
    const broken = { ...GOOD_STORY, kid: { ...GOOD_STORY.kid, whyImportant: '' }, teen: undefined };
    expect(validateStory(broken).errors).toEqual(['kid.whyImportant is empty', 'missing "teen" version']);
    const long = { ...GOOD_STORY, young: version({ what: 200, why: 10, words: [word('A'), word('B')] }) };
    expect(validateStory(long).flags).toEqual(['young: 2 new words (expected 1-1)', expect.stringMatching(/^young: \d+ words/)]);
  });

  test('numbers and names that are not in the source are flagged for the editor', () => {
    const item = {
      title: 'ISRO launches weather satellite Meghdoot',
      description: 'ISRO launched the weather satellite Meghdoot on Monday. It will help forecast rain and give farmers better warnings.',
    };
    expect(verifyAgainstSource(GOOD_STORY, item)).toEqual(['did-you-know facts need a source check']);

    const invented = { ...GOOD_STORY, kid: { ...GOOD_STORY.kid, whatHappened: 'It cost 500 crore and was built with Japan.' } };
    const flags = verifyAgainstSource(invented, item);
    expect(flags).toContain('numbers not in source: 500');
    expect(flags).toContain('names not in source: Japan');
  });

  test('extractJSON tolerates code fences and surrounding words', () => {
    expect(extractJSON('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => extractJSON('no json')).toThrow();
  });

  test('parseArgs', () => {
    expect(parseArgs(['--dry-run', '--date=2026-11-09', '--max=5'])).toMatchObject({ dryRun: true, date: '2026-11-09', max: 5 });
    expect(() => parseArgs(['--date=09-11-2026'])).toThrow();
  });
});

describe('runDigestPipeline', () => {
  const feeds = {
    'https://pib.gov.in/rss': rss([
      { title: 'ISRO launches weather satellite Meghdoot', link: 'https://pib.gov.in/PressRelease?PRID=1', description: 'ISRO launched Meghdoot on Monday to help forecast rain.' },
      { title: 'Off-site link', link: 'https://example.com/fake' },
      { title: 'Two killed in road accident', link: 'https://pib.gov.in/PressRelease?PRID=2' },
      { title: 'Very old news item here', link: 'https://pib.gov.in/PressRelease?PRID=3', date: 'Mon, 02 Nov 2026 00:00:00 GMT' },
    ]),
    'https://www.nasa.gov/feed/': rss([
      { title: 'NASA telescope spots new planet', link: 'https://www.nasa.gov/news/planet', description: 'NASA said its telescope found a planet.' },
      { title: 'Already saved story', link: 'https://www.nasa.gov/news/saved' },
    ]),
  };
  const fetchImpl = async (url) => (feeds[url]
    ? { ok: true, text: async () => feeds[url] }
    : { ok: false, status: 404, text: async () => '' });

  afterEach(() => { delete process.env.CA_AUTO_PUBLISH; });

  test("with auto-publish off, saves verified, de-duplicated stories with status 'review' only", async () => {
    process.env.CA_AUTO_PUBLISH = 'off';
    const supabase = createFakeSupabase();
    supabase.__seed('ca_stories', [storyRow({ source_url_hash: urlHash('https://www.nasa.gov/news/saved') })]);
    const llm = jest.fn(async () => ({ model: 'fake', data: GOOD_STORY }));
    const logger = quietLogger();

    const summary = await runDigestPipeline({ sources: [PIB, NASA], fetchImpl, supabase, llm, now: NOW, logger });

    expect(summary).toMatchObject({ date: '2026-11-09', saved: 2, failed: 0 });
    expect(llm).toHaveBeenCalledTimes(2);
    const saved = supabase.__rows('ca_stories').filter((r) => r.source_url_hash !== urlHash('https://www.nasa.gov/news/saved'));
    expect(saved).toHaveLength(2);
    for (const row of saved) {
      expect(row).toMatchObject({ status: 'review', is_true_fact: false, publish_date: '2026-11-09' });
      expect(row.review_notes).toContain('did-you-know facts need a source check');
      expect(row.age_extras.young.newWords).toHaveLength(1);
    }
    // PIB is a general India source; an ISRO satellite story is re-classified as science.
    expect(saved.map((r) => `${r.source}:${r.category}`).sort()).toEqual(['NASA:science', 'PIB:science']);
    expect(saved.find((r) => r.source === 'PIB')).toMatchObject({ new_word_1: 'Satellite', new_word_2: 'Forecast', new_word_3: 'Orbit' });

    const actions = logger.entries.map((e) => `${e.action}:${e.reason || ''}`);
    expect(actions).toEqual(expect.arrayContaining([
      "rejected:link is not on the source's own site",
      'rejected:unsuitable for children ("killed")',
      'deduplicated:already in ca_stories',
    ]));
    expect(logger.entries.filter((e) => e.action === 'saved_for_review')).toHaveLength(2);
  });

  test('a story with no fact-check problems is published without its unchecked "did you know"; one with problems waits', async () => {
    const clean = {
      'https://pib.gov.in/rss': rss([{
        title: 'ISRO launches weather satellite Meghdoot',
        link: 'https://pib.gov.in/PressRelease?PRID=7',
        description: 'ISRO launched the weather satellite Meghdoot on Monday from Sriharikota to help forecast rain and storms across the country this season.',
      }]),
      'https://www.nasa.gov/feed/': feeds['https://www.nasa.gov/feed/'],
    };
    const supabase = createFakeSupabase();
    const logger = quietLogger();
    const summary = await runDigestPipeline({
      sources: [PIB, NASA], fetchImpl: async (url) => ({ ok: true, text: async () => clean[url] }),
      supabase, llm: async () => ({ model: 'fake', data: GOOD_STORY }), now: NOW, logger,
    });
    expect(summary).toMatchObject({ saved: 3, published: 1 });

    const pib = supabase.__rows('ca_stories').find((r) => r.source === 'PIB');
    expect(pib).toMatchObject({ status: 'published', reviewed_by: 'auto', did_you_know: null, is_true_fact: false });
    expect(Object.values(pib.age_extras).some((v) => v.didYouKnow)).toBe(false);
    expect(pib.age_extras.kid.newWords).toHaveLength(2);
    expect(pib.review_notes).toMatch(/Published automatically/);
    expect(pib.review_notes).toContain('Aryabhata'); // kept for the editor to check and add back

    // NASA's article never mentions ISRO or Meghdoot, and has little text: held.
    for (const row of supabase.__rows('ca_stories').filter((r) => r.source === 'NASA')) {
      expect(row.status).toBe('review');
      expect(row.did_you_know).toBeTruthy();
      expect(row.review_notes).toMatch(/names not in source/);
    }
    expect(logger.entries.filter((e) => e.action === 'published')).toHaveLength(1);
  });

  test('a dry run saves nothing; bad or skipped writer output is logged, not saved', async () => {
    const supabase = createFakeSupabase();
    const llm = jest.fn()
      .mockResolvedValueOnce({ model: 'fake', data: { skip: true, reason: 'too little information' } })
      .mockResolvedValueOnce({ model: 'fake', data: { young: {} } })
      .mockRejectedValueOnce(new Error('Groq down'));
    const logger = quietLogger();
    const summary = await runDigestPipeline({ sources: [PIB, NASA], fetchImpl, supabase, llm, now: NOW, logger });
    expect(summary).toMatchObject({ saved: 0, skipped: 1, failed: 2 });
    expect(supabase.__rows('ca_stories')).toHaveLength(0);

    const dry = await runDigestPipeline({
      sources: [PIB], fetchImpl, supabase, llm: async () => ({ model: 'fake', data: GOOD_STORY }), now: NOW, logger: quietLogger(), dryRun: true,
    });
    expect(dry.rows).toHaveLength(1);
    expect(supabase.__rows('ca_stories')).toHaveLength(0);
  });

  test('a failing source is logged and the others still run', async () => {
    const logger = quietLogger();
    const broken = { ...NASA, id: 'broken', url: 'https://www.nasa.gov/missing' };
    const summary = await runDigestPipeline({
      sources: [broken, PIB], fetchImpl, supabase: createFakeSupabase(),
      llm: async () => ({ model: 'fake', data: GOOD_STORY }), now: NOW, logger,
    });
    expect(summary.saved).toBe(1);
    expect(logger.entries.find((e) => e.action === 'source_failed')).toMatchObject({ source: 'broken' });
  });
});

describe('runQuizPipeline', () => {
  const stories = ['india', 'world', 'science', 'economy', 'sports'].map((category, i) =>
    storyRow({ n: i + 1, category, publish_date: '2026-11-05' }));
  const goodQuiz = () => ({
    questions: WEEK_PLAN.map(([category, type], i) => ({
      storyId: stories.find((s) => s.category === category)?.id || null,
      category, type, question: `Question ${i + 1}?`,
      options: type === 'true_false' ? ['True', 'False'] : ['A', 'B', 'C', 'D'],
      correctIndex: 0, explanation: 'Because.', extraFact: 'Fact.',
    })),
  });

  afterEach(() => { delete process.env.CA_AUTO_PUBLISH; });

  test("writes 10 questions per age group from last week's published stories and publishes them", async () => {
    const supabase = createFakeSupabase();
    supabase.__seed('ca_stories', [...stories, storyRow({ status: 'review', publish_date: '2026-11-05' }), storyRow({ publish_date: '2026-10-20' })]);
    const llm = jest.fn(async (messages) => {
      expect(messages[1].content.split('\n- id ').length - 1).toBe(5); // only last week's published stories
      return { model: 'fake', data: goodQuiz() };
    });
    const { weekStart, results } = await runQuizPipeline({ supabase, llm, now: NOW, logger: quietLogger() });
    expect(weekStart).toBe('2026-11-08');
    expect(results.map((r) => r.saved)).toEqual([10, 10, 10]);
    const rows = supabase.__rows('ca_quiz_questions');
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.status === 'published' && r.reviewed_by === 'auto' && r.week_start === '2026-11-08')).toBe(true);
    expect(results.every((r) => r.published)).toBe(true);

    // Re-running the same week does nothing without --force.
    const again = await runQuizPipeline({ supabase, llm, now: NOW, logger: quietLogger() });
    expect(again.results).toEqual([]);
  });

  test('a quiz citing a story from outside the week waits for an editor; so does everything with auto-publish off', async () => {
    const supabase = createFakeSupabase();
    supabase.__seed('ca_stories', stories);
    const strayQuiz = () => { const q = goodQuiz(); q.questions[0].storyId = '00000000-0000-4000-8000-000000000000'; return q; };
    await runQuizPipeline({ supabase, llm: async () => ({ model: 'fake', data: strayQuiz() }), ages: ['8-12'], now: NOW, logger: quietLogger() });
    const held = supabase.__rows('ca_quiz_questions');
    expect(held).toHaveLength(10);
    expect(held.every((r) => r.status === 'review' && /storyId not in this week/.test(r.review_notes))).toBe(true);

    process.env.CA_AUTO_PUBLISH = 'off';
    await runQuizPipeline({ supabase, llm: async () => ({ model: 'fake', data: goodQuiz() }), ages: ['13+'], now: NOW, logger: quietLogger() });
    expect(supabase.__rows('ca_quiz_questions').filter((r) => r.age_group === '13+').every((r) => r.status === 'review')).toBe(true);
  });

  test('rejects malformed sets and flags composition gaps', () => {
    const ids = new Set(stories.map((s) => s.id));
    expect(validateQuiz(goodQuiz(), ids)).toEqual({ errors: [], flags: [] });

    const bad = goodQuiz();
    bad.questions[1].options = ['Yes', 'No'];
    bad.questions[0].correctIndex = 9;
    bad.questions.pop();
    const { errors } = validateQuiz(bad, ids);
    expect(errors).toEqual(expect.arrayContaining(['expected 10 questions, got 9', 'Q1: correctIndex out of range', 'Q2: true_false options must be ["True", "False"]']));

    const skewed = goodQuiz();
    skewed.questions[8].category = 'india';
    expect(validateQuiz(skewed, ids).flags).toEqual(['3 questions for india (expected 2)', '1 questions for sports/society (expected 2)']);
  });
});
