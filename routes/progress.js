const express = require('express');
const supabase = require('../services/supabase');
const { localDate, quizWeekStart, isUuid, isDateString } = require('../services/content');
const { getProgress, recordDigestComplete, recordStoryRead, recordQuizComplete } = require('../services/progress');
const { check } = require('../services/db');
const { requireSelf } = require('../middleware/auth');
const { readStudent, handle } = require('./helpers');

const router = express.Router();

// ── GET /current-affairs/progress/:studentEmail?ageGroup=8-12 ───────────────
// Points, streaks, counts and badges. Without ageGroup: the student's most
// recently active age group. A student with no activity gets zeros.
router.get('/:studentEmail', requireSelf((req) => req.params.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, { ...req.query, studentEmail: req.params.studentEmail },
    { emailRequired: true, ageGroupRequired: req.query.ageGroup !== undefined });
  if (!student) return;
  res.json({ progress: await getProgress(student.email, student.ageGroup, localDate()) });
}));

// ── POST /current-affairs/progress/digest-complete { studentEmail, ageGroup, storyCount? } ──
// +10 points once per day; extends the daily streak (weekly streak badge at 7 days).
router.post('/digest-complete', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const storyCount = Math.min(50, Math.max(0, parseInt(body.storyCount, 10) || 0));
  res.json(await recordDigestComplete(student.email, student.ageGroup, localDate(), storyCount));
}));

// ── POST /current-affairs/progress/story-read { studentEmail, ageGroup, storyId, durationSeconds? } ──
// +5 points the first time a student reads a story.
router.post('/story-read', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  if (!isUuid(body.storyId)) return res.status(400).json({ error: 'storyId required' });

  const story = check(await supabase.from('ca_stories').select('id')
    .eq('id', body.storyId).eq('status', 'published').maybeSingle());
  if (!story) return res.status(404).json({ error: 'Story not found' });

  const duration = Number.isFinite(Number(body.durationSeconds))
    ? Math.min(3600, Math.max(0, Math.round(Number(body.durationSeconds)))) : null;
  res.json(await recordStoryRead(student.email, student.ageGroup, body.storyId, localDate(), duration));
}));

// ── POST /current-affairs/progress/quiz-complete { studentEmail, ageGroup, attemptId? | weekStart? } ──
// +20 points once per quiz attempt, +10 bonus and the excellence badge at 80%+,
// growth badge when the score beats the previous quiz. The score always comes
// from the stored, server-graded attempt — never from the request.
router.post('/quiz-complete', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  if (body.attemptId !== undefined && !isUuid(body.attemptId)) return res.status(400).json({ error: 'attemptId is not valid' });
  if (body.weekStart !== undefined && !isDateString(body.weekStart)) return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });

  const today = localDate();
  const result = await recordQuizComplete(student.email, student.ageGroup, {
    attemptId: body.attemptId,
    weekStart: body.weekStart || quizWeekStart(today),
  }, today);
  if (result.notFound) return res.status(404).json({ error: 'Submit the quiz before completing it' });
  res.json(result);
}));

module.exports = router;
