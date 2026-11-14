// Current Affairs analytics for the admin content tool: is the digest being
// read and finished, and is the quiz played and answered well? Computed from
// the activity tables; nothing extra is stored.
//
//   digestCompletionRate  of the days a student read at least one story, the
//                         share on which they finished the whole digest
//   avgReadingSeconds     average time spent on one story (reads with a time)
//   avgMinutesPerDay      reading time per student per reading day
//   quizParticipation     share of active students who played a weekly quiz
//   quizAccuracy          average quiz score (%)
//   retention30           of students active in the 30 days before the last
//                         30 days, the share still active in the last 30 days
//   dailyActiveReaders    average number of students reading per day
//   avgStreak             average current daily streak of active students
// ("active" = read a story, finished a digest or played a quiz in the range)
const supabase = require('./supabase');
const { check } = require('./db');
const { addDays } = require('./content');

const PAGE = 1000; // PostgREST returns at most 1000 rows per request

async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = check(await build().range(from, from + PAGE - 1));
    rows.push(...(page || []));
    if (!page || page.length < PAGE) return rows;
  }
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const ratio = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null); // percent, 1 decimal
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

async function activity({ from, to, ageGroup }) {
  const byAge = (q) => (ageGroup ? q.eq('age_group', ageGroup) : q);
  const [reads, views, attempts] = await Promise.all([
    fetchAll(() => byAge(supabase.from('ca_story_reads').select('student_email, read_date, duration_seconds')
      .gte('read_date', from).lte('read_date', to)).order('read_date', { ascending: true })),
    fetchAll(() => byAge(supabase.from('ca_digest_views').select('student_email, view_date')
      .gte('view_date', from).lte('view_date', to)).order('view_date', { ascending: true })),
    // A quiz week starting up to 6 days before the range is still being played in it.
    fetchAll(() => byAge(supabase.from('ca_quiz_attempts').select('student_email, week_start, percentage')
      .gte('week_start', addDays(from, -6)).lte('week_start', to)).order('week_start', { ascending: true })),
  ]);
  return { reads, views, attempts };
}

function activeStudents({ reads, views, attempts }) {
  return new Set([...reads, ...views, ...attempts].map((r) => r.student_email));
}

async function computeMetrics({ from, to, ageGroup = null }) {
  const data = await activity({ from, to, ageGroup });
  const { reads, views, attempts } = data;
  const active = activeStudents(data);

  // Digest completion: student-days with any reading (or a finished digest).
  const readingDays = new Set([...reads.map((r) => `${r.student_email}|${r.read_date}`), ...views.map((v) => `${v.student_email}|${v.view_date}`)]);
  const completedDays = new Set(views.map((v) => `${v.student_email}|${v.view_date}`));

  const timed = reads.filter((r) => Number.isFinite(r.duration_seconds) && r.duration_seconds > 0);
  const secondsByDay = new Map();
  for (const r of timed) {
    const key = `${r.student_email}|${r.read_date}`;
    secondsByDay.set(key, (secondsByDay.get(key) || 0) + r.duration_seconds);
  }

  const players = new Set(attempts.map((a) => a.student_email));

  // Retention: the 30 days before the last 30 days of the range vs the last 30.
  const lastStart = addDays(to, -29);
  const prevStart = addDays(to, -59);
  const prevEnd = addDays(to, -30);
  const longer = await activity({ from: prevStart, to, ageGroup });
  const dateOf = (r) => r.read_date || r.view_date || r.week_start;
  const all = [...longer.reads, ...longer.views, ...longer.attempts];
  const before = new Set(all.filter((r) => dateOf(r) >= prevStart && dateOf(r) <= prevEnd).map((r) => r.student_email));
  const after = new Set(all.filter((r) => dateOf(r) >= lastStart && dateOf(r) <= to).map((r) => r.student_email));
  const retained = [...before].filter((e) => after.has(e)).length;

  // Daily series (also gives daily active readers).
  const days = daysBetween(from, to);
  const daily = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    daily.push({
      date,
      readers: new Set(reads.filter((r) => r.read_date === date).map((r) => r.student_email)).size,
      storiesRead: reads.filter((r) => r.read_date === date).length,
      digestsCompleted: views.filter((v) => v.view_date === date).length,
    });
  }

  // Streaks of students whose progress changed in the range (the active ones).
  const progress = active.size
    ? await fetchAll(() => {
      const q = supabase.from('ca_progress').select('student_email, age_group, current_streak, updated_at').gte('updated_at', `${from}T00:00:00Z`);
      return (ageGroup ? q.eq('age_group', ageGroup) : q).order('student_email', { ascending: true });
    })
    : [];

  return {
    range: { from, to, days, ageGroup: ageGroup || 'all' },
    activeStudents: active.size,
    metrics: {
      digestCompletionRate: { value: ratio(completedDays.size, readingDays.size), unit: '%', completed: completedDays.size, readingDays: readingDays.size },
      avgReadingSeconds: { value: round1(avg(timed.map((r) => r.duration_seconds))), unit: 's', reads: reads.length, timedReads: timed.length },
      avgMinutesPerDay: { value: round1(avg([...secondsByDay.values()].map((s) => s / 60))), unit: 'min' },
      quizParticipation: { value: ratio(players.size, active.size), unit: '%', players: players.size },
      quizAccuracy: { value: round1(avg(attempts.map((a) => a.percentage).filter(Number.isFinite))), unit: '%', attempts: attempts.length },
      retention30: { value: ratio(retained, before.size), unit: '%', previous: before.size, retained },
      dailyActiveReaders: { value: round1(avg(daily.map((d) => d.readers))), unit: 'students' },
      avgStreak: { value: round1(avg(progress.map((p) => p.current_streak || 0))), unit: 'days' },
    },
    daily,
  };
}

module.exports = { computeMetrics, daysBetween };
