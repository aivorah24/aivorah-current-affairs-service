// What the pipeline may publish by itself, and what waits for an editor in
// the admin content tool. Without this, every story and quiz waited for a
// person, so a day nobody reviewed was an empty digest for every student.
//
// Held for an editor: anything that may state a fact the source does not -
// numbers or names missing from the source, a source with too little text to
// check against, a quiz question tied to a story outside that week. Style
// notes (word counts, number of new words, the category mix) do not hold
// anything back; they stay in review_notes for the editor to see.
//
// A story's "did you know" comes from outside the source, so it is never
// published unchecked: an auto-published story goes out without it, and the
// text is kept in review_notes for an editor to check and add back.
//
// CA_AUTO_PUBLISH=off keeps everything for review (the old behaviour).

const STORY_BLOCKERS = [/^numbers not in source/, /^names not in source/, /^source had little text/];
const QUIZ_BLOCKERS = [/storyId not in this week's stories/];
const DID_YOU_KNOW_FLAG = 'did-you-know facts need a source check';

const enabled = (env = process.env) => String(env.CA_AUTO_PUBLISH || 'on').toLowerCase() !== 'off';

function storyDecision(flags, env = process.env) {
  if (!enabled(env)) return { publish: false, reasons: ['auto-publish is off'] };
  const reasons = flags.filter((f) => STORY_BLOCKERS.some((re) => re.test(f)));
  return { publish: reasons.length === 0, reasons };
}

function quizDecision(flags, env = process.env) {
  if (!enabled(env)) return { publish: false, reasons: ['auto-publish is off'] };
  const reasons = flags.filter((f) => QUIZ_BLOCKERS.some((re) => re.test(f)));
  return { publish: reasons.length === 0, reasons };
}

// The row as it is saved: published (without unchecked facts) or for review.
function applyStoryDecision(row, flags, decision, at = new Date()) {
  const notes = flags.filter((f) => f !== DID_YOU_KNOW_FLAG);
  if (!decision.publish) {
    return { ...row, status: 'review', review_notes: [...notes, DID_YOU_KNOW_FLAG].join('\n') || null };
  }
  const unchecked = [];
  if (row.did_you_know) unchecked.push(`kid: ${row.did_you_know}`);
  const extras = {};
  for (const [age, value] of Object.entries(row.age_extras || {})) {
    const { didYouKnow, ...rest } = value || {};
    if (didYouKnow) unchecked.push(`${age}: ${didYouKnow}`);
    extras[age] = rest;
  }
  return {
    ...row,
    status: 'published',
    did_you_know: null,
    age_extras: extras,
    reviewed_by: 'auto',
    reviewed_at: at.toISOString(),
    review_notes: [
      'Published automatically: no fact-check problems found.',
      ...notes,
      ...(unchecked.length ? ['Did-you-know removed until an editor checks it:', ...unchecked] : []),
    ].join('\n'),
  };
}

function applyQuizDecision(rows, flags, decision, at = new Date()) {
  const notes = flags.length ? flags.join('\n') : null;
  if (!decision.publish) return rows.map((r) => ({ ...r, status: 'review', review_notes: notes }));
  return rows.map((r) => ({
    ...r,
    status: 'published',
    reviewed_by: 'auto',
    reviewed_at: at.toISOString(),
    review_notes: ['Published automatically.', ...flags].join('\n'),
  }));
}

module.exports = { storyDecision, quizDecision, applyStoryDecision, applyQuizDecision, enabled, DID_YOU_KNOW_FLAG };
