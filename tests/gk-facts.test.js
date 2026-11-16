jest.mock('../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));

const request = require('supertest');
const app = require('../index');
const gk = require('../services/gk-facts');
const { freezeTime } = require('./helpers/fixtures');

const get = (path) => request(app).get(`/current-affairs/gk${path}`);

afterEach(() => jest.useRealTimers());

describe('GET /current-affairs/gk/today', () => {
  test("returns today's events (India time)", async () => {
    freezeTime('2026-11-14T06:00:00Z'); // 14 Nov in Asia/Kolkata — Children's Day
    const res = await get('/today');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-11-14');
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.events.every((e) => e.date === '11-14')).toBe(true);
    expect(res.body.events.map((e) => e.event_name)).toEqual(expect.arrayContaining([expect.stringMatching(/Children's Day/)]));
  });

  test('uses the India date near midnight UTC', async () => {
    freezeTime('2026-01-25T20:00:00Z'); // already 26 Jan in India
    const res = await get('/today');
    expect(res.body.date).toBe('2026-01-26');
    expect(res.body.events.every((e) => e.date === '01-26')).toBe(true);
  });
});

describe('GET /current-affairs/gk/date', () => {
  test.each(['01-26', '2026-01-26'])('accepts %s', async (date) => {
    const res = await get(`/date?date=${date}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.events.every((e) => e.date === '01-26')).toBe(true);
  });

  test('missing date is a 400', async () => {
    expect((await get('/date')).status).toBe(400);
  });
});

describe('GET /current-affairs/gk/quiz', () => {
  test('each question has 4 distinct options with the correct one at correct_index', async () => {
    const res = await get('/quiz?date=01-26&num=3');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
    for (const q of res.body.questions) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options[q.correct_index]).toBe(q.correct_answer);
    }
  });

  test('wrong options vary between quizzes instead of always being the same events', () => {
    const wrong = new Set();
    for (let i = 0; i < 10; i++) {
      for (const q of gk.generateQuizForDate('11-14', 1)) {
        q.options.filter((o) => o !== q.correct_answer).forEach((o) => wrong.add(o));
      }
    }
    expect(wrong.size).toBeGreaterThan(3);
  });

  test('a "how is it celebrated" question offers other celebrations, not descriptions', () => {
    const descriptions = new Set(gk.loadEvents().map((e) => e.description));
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.85); // type index floor(0.85*5)=4 → 'how'
    try {
      const [q] = gk.generateQuizForDate('11-14', 1);
      expect(q.type).toBe('how');
      const wrong = q.options.filter((o) => o !== q.correct_answer);
      expect(wrong.some((o) => descriptions.has(o))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('other GK endpoints', () => {
  test('search finds matching events', async () => {
    const res = await get('/search?q=republic%20constitution');
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.event_name)).toEqual(expect.arrayContaining([expect.stringMatching(/republic day/i)]));
  });

  test('calendar returns only that month', async () => {
    const res = await get('/calendar?month=11');
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.events.every((e) => e.date.startsWith('11-'))).toBe(true);
  });

  test('event lookup by partial name, 404 when unknown', async () => {
    expect((await get('/event?name=republic')).body.event_name).toMatch(/republic/i);
    expect((await get('/event?name=zzzz-no-such-day')).status).toBe(404);
  });
});
