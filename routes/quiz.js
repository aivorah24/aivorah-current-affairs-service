const express = require('express');
const supabase = require('../services/supabase');
const { localDate, isDateString, addDays, quizWeekStart, isUuid } = require('../services/content');
const { pickQuizQuestions, publicQuestion, reveal, gradeQuiz } = require('../services/quiz');
const { EXCELLENCE_PERCENT } = require('../services/rewards');
const { check } = require('../services/db');
const { requireSelf } = require('../middleware/auth');
const { readStudent, handle } = require('./helpers');

const router = express.Router();

async function weekQuestions(ageGroup, weekStart) {
  const rows = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('status', 'published').eq('age_group', ageGroup).eq('week_start', weekStart)
    .order('position', { ascending: true }));
  return pickQuizQuestions(rows || []);
}

async function findAttempt(email, ageGroup, weekStart) {
  return check(await supabase.from('ca_quiz_attempts').select('*')
    .eq('student_email', email).eq('age_group', ageGroup).eq('week_start', weekStart)
    .maybeSingle());
}

// A stored attempt → the result the app shows (graded against the week's questions).
function attemptResult(attempt, questions) {
  const answers = (attempt.answers || []).map((a) => ({ questionId: a.questionId, answer: a.selected }));
  const graded = gradeQuiz(questions, answers);
  return {
    attemptId: attempt.id,
    weekStart: attempt.week_start,
    score: attempt.score,
    total: attempt.total,
    percentage: attempt.percentage,
    excellence: attempt.percentage >= EXCELLENCE_PERCENT,
    pointsAwarded: !!attempt.points_awarded,
    results: graded.results,
  };
}

// weekStart from the client must be this week's Sunday or last week's
// (a quiz started on Saturday night can still be submitted after midnight).
function resolveWeek(requested, today) {
  const current = quizWeekStart(today);
  if (requested === undefined || requested === null || requested === '') return current;
  if (!isDateString(requested)) return null;
  return requested === current || requested === addDays(current, -7) ? requested : null;
}

// ── GET /current-affairs/quiz/week?ageGroup=8-12&studentEmail=&weekStart= ───
// This week's 10 questions without answers. With studentEmail, also the
// student's attempt if they already took it (attempt: null otherwise).
router.get('/week', requireSelf((req) => req.query.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, req.query, { emailRequired: false });
  if (!student) return;
  const { ageGroup, email } = student;
  const weekStart = resolveWeek(req.query.weekStart, localDate());
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's or last week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  let attempt = null;
  if (email && questions.length) {
    const row = await findAttempt(email, ageGroup, weekStart);
    if (row) attempt = attemptResult(row, questions);
  }
  res.json({
    weekStart,
    ageGroup,
    total: questions.length,
    questions: questions.map(publicQuestion),
    attempt,
  });
}));

// ── POST /current-affairs/quiz/check { questionId, answer } ─────────────────
// Reveals one question's answer after the student has picked an option.
router.post('/check', handle(async (req, res) => {
  const { questionId, answer } = req.body || {};
  if (!isUuid(questionId)) return res.status(400).json({ error: 'questionId required' });
  if (!Number.isInteger(answer) || answer < 0) return res.status(400).json({ error: 'answer must be the option index' });

  const row = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('id', questionId).eq('status', 'published').maybeSingle());
  if (!row) return res.status(404).json({ error: 'Question not found' });
  if (answer >= row.options.length) return res.status(400).json({ error: 'answer is not one of the options' });

  res.json({ questionId, selected: answer, correct: answer === row.correct_index, ...reveal(row) });
}));

// ── POST /current-affairs/quiz/submit { studentEmail, ageGroup, answers, weekStart? } ──
// Grades on the server and stores one attempt per student per week. A second
// submit for the same week returns the first result (alreadySubmitted: true).
router.post('/submit', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const { ageGroup, email } = student;
  if (!Array.isArray(body.answers)) return res.status(400).json({ error: 'answers must be an array of { questionId, answer }' });
  const weekStart = resolveWeek(body.weekStart, localDate());
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's or last week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  if (!questions.length) return res.status(404).json({ error: 'There is no quiz for this week yet' });

  const graded = gradeQuiz(questions, body.answers);
  const inserted = check(await supabase.from('ca_quiz_attempts')
    .upsert({
      student_email: email,
      age_group: ageGroup,
      week_start: weekStart,
      answers: graded.results.map((r) => ({
        questionId: r.questionId, selected: r.selected, correctIndex: r.correctIndex, correct: r.correct,
      })),
      score: graded.score,
      total: graded.total,
      percentage: graded.percentage,
    }, { onConflict: 'student_email,age_group,week_start', ignoreDuplicates: true })
    .select());

  if (!inserted?.length) {
    const existing = await findAttempt(email, ageGroup, weekStart);
    return res.json({ ...attemptResult(existing, questions), alreadySubmitted: true });
  }
  res.json({ ...attemptResult(inserted[0], questions), alreadySubmitted: false });
}));

module.exports = router;
