// Weekly quiz: choosing the 10 questions and grading answers. Pure functions.

const QUIZ_SIZE = 10;

// PRD composition: 2 each from these 5 groups.
const CATEGORY_SLOTS = [
  ['india'], ['world'], ['science'], ['economy', 'environment'], ['sports', 'society'],
];
const PER_SLOT = 2;
const TYPE_QUOTA = { mcq: 6, true_false: 2, reasoning: 2 };

function byPosition(a, b) {
  return (a.position ?? 0) - (b.position ?? 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

// Picks up to 10 questions: 2 per category group, preferring question types
// whose quota (6 mcq / 2 true_false / 2 reasoning) is not yet filled, then tops
// up from whatever is left if a group is short. Keeps the slot order
// (India, World, Science, Economy/Environment, Sports/Society).
function pickQuizQuestions(rows) {
  const pool = [...(rows || [])].sort(byPosition);
  const used = new Set();
  const typeCount = { mcq: 0, true_false: 0, reasoning: 0 };
  const picked = [];

  const take = (q) => {
    used.add(q.id);
    typeCount[q.question_type] = (typeCount[q.question_type] || 0) + 1;
    picked.push(q);
  };
  const preferOpenType = (candidates) =>
    candidates.find((q) => (typeCount[q.question_type] || 0) < (TYPE_QUOTA[q.question_type] ?? 0)) || candidates[0];

  for (const cats of CATEGORY_SLOTS) {
    for (let i = 0; i < PER_SLOT; i++) {
      const candidates = pool.filter((q) => !used.has(q.id) && cats.includes(q.category));
      if (!candidates.length) break;
      take(preferOpenType(candidates));
    }
  }
  while (picked.length < QUIZ_SIZE) {
    const candidates = pool.filter((q) => !used.has(q.id));
    if (!candidates.length) break;
    take(preferOpenType(candidates));
  }
  return picked;
}

// What the student sees before answering — no correct answer, no explanation.
function publicQuestion(row) {
  return {
    id: row.id,
    category: row.category,
    type: row.question_type,
    question: row.question,
    options: row.options,
    storyId: row.story_id || null,
  };
}

function reveal(row) {
  return {
    correctIndex: row.correct_index,
    explanation: row.explanation,
    extraFact: row.extra_fact || null,
    storyId: row.story_id || null,
  };
}

// answers: [{ questionId, answer }] where answer is the chosen option index.
// Unanswered or out-of-range answers count as wrong.
function gradeQuiz(questions, answers) {
  const chosen = new Map();
  for (const a of Array.isArray(answers) ? answers : []) {
    if (a && a.questionId) chosen.set(String(a.questionId), a.answer);
  }
  const results = questions.map((q) => {
    const raw = chosen.get(String(q.id));
    const selected = Number.isInteger(raw) && raw >= 0 && raw < q.options.length ? raw : null;
    return {
      questionId: q.id,
      category: q.category,
      type: q.question_type,
      question: q.question,
      options: q.options,
      selected,
      correct: selected === q.correct_index,
      ...reveal(q),
    };
  });
  const score = results.filter((r) => r.correct).length;
  const total = results.length;
  return { score, total, percentage: total ? Math.round((score / total) * 100) : 0, results };
}

module.exports = { QUIZ_SIZE, TYPE_QUOTA, CATEGORY_SLOTS, pickQuizQuestions, publicQuestion, reveal, gradeQuiz };
