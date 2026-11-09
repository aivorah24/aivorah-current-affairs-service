// Progress reads/writes. Each award is gated by a unique row first (one digest
// per day, one read per story, one points award per quiz attempt), then applied
// in one atomic statement with the ca_apply_progress() Postgres function.
const supabase = require('./supabase');
const { check } = require('./db');
const { POINTS, EXCELLENCE_PERCENT, displayedStreak, digestRewards, quizRewards } = require('./rewards');

async function getProgressRow(email, ageGroup) {
  return check(await supabase.from('ca_progress').select('*')
    .eq('student_email', email).eq('age_group', ageGroup).maybeSingle());
}

async function latestProgressRow(email) {
  const rows = check(await supabase.from('ca_progress').select('*')
    .eq('student_email', email).order('updated_at', { ascending: false }).limit(1));
  return rows?.[0] || null;
}

async function applyProgress(params) {
  const data = check(await supabase.rpc('ca_apply_progress', params));
  return Array.isArray(data) ? data[0] : data;
}

// Row → what the app shows. A missing row is a fresh student with zeros.
function toProgress(row, email, ageGroup, today) {
  const r = row || {};
  return {
    studentEmail: email,
    ageGroup: r.age_group || ageGroup,
    points: r.points || 0,
    currentStreak: displayedStreak(r.last_digest_date, r.current_streak, today),
    longestStreak: r.longest_streak || 0,
    digestsCompleted: r.digests_completed || 0,
    storiesRead: r.stories_read || 0,
    quizzesCompleted: r.quizzes_completed || 0,
    bestQuizScore: r.best_quiz_score ?? null,
    lastQuizScore: r.last_quiz_score ?? null,
    badges: {
      excellence: !!r.badge_excellence,
      weeklyStreak: !!r.badge_weekly_streak,
      growth: !!r.badge_growth,
    },
    lastDigestDate: r.last_digest_date || null,
    lastQuizDate: r.last_quiz_date || null,
    digestCompletedToday: r.last_digest_date === today,
  };
}

async function getProgress(email, ageGroup, today) {
  const row = ageGroup ? await getProgressRow(email, ageGroup) : await latestProgressRow(email);
  return toProgress(row, email, ageGroup || row?.age_group || '8-12', today);
}

// Best-effort undo of a gate row when applying the points failed, so a retry can award them.
async function undo(query) {
  try { await query; } catch (e) { console.error('[progress] could not undo gate row:', e.message); }
}

async function recordDigestComplete(email, ageGroup, today, storyCount = 0) {
  const inserted = check(await supabase.from('ca_digest_views')
    .upsert({ student_email: email, age_group: ageGroup, view_date: today, story_count: storyCount },
      { onConflict: 'student_email,view_date', ignoreDuplicates: true })
    .select());
  const before = await getProgressRow(email, ageGroup);
  if (!inserted?.length) {
    return { alreadyCompleted: true, pointsAwarded: 0, newBadges: [], progress: toProgress(before, email, ageGroup, today) };
  }

  const reward = digestRewards(before, today);
  let row;
  try {
    row = await applyProgress({
      p_student_email: email, p_age_group: ageGroup,
      p_points: reward.points, p_digests: 1,
      p_current_streak: reward.streak, p_last_digest_date: today,
      p_badge_weekly_streak: reward.weeklyStreak,
    });
  } catch (e) {
    await undo(supabase.from('ca_digest_views').delete().eq('student_email', email).eq('view_date', today));
    throw e;
  }
  return { alreadyCompleted: false, pointsAwarded: reward.points, newBadges: reward.newBadges, progress: toProgress(row, email, ageGroup, today) };
}

async function recordStoryRead(email, ageGroup, storyId, today, durationSeconds = null) {
  const inserted = check(await supabase.from('ca_story_reads')
    .upsert({ student_email: email, story_id: storyId, age_group: ageGroup, read_date: today, duration_seconds: durationSeconds },
      { onConflict: 'student_email,story_id', ignoreDuplicates: true })
    .select());
  if (!inserted?.length) {
    return { alreadyRead: true, pointsAwarded: 0, progress: toProgress(await getProgressRow(email, ageGroup), email, ageGroup, today) };
  }
  let row;
  try {
    row = await applyProgress({
      p_student_email: email, p_age_group: ageGroup,
      p_points: POINTS.story, p_stories: 1, p_last_story_date: today,
    });
  } catch (e) {
    await undo(supabase.from('ca_story_reads').delete().eq('student_email', email).eq('story_id', storyId));
    throw e;
  }
  return { alreadyRead: false, pointsAwarded: POINTS.story, progress: toProgress(row, email, ageGroup, today) };
}

async function findAttempt(email, ageGroup, { attemptId, weekStart }) {
  let query = supabase.from('ca_quiz_attempts').select('*').eq('student_email', email).eq('age_group', ageGroup);
  query = attemptId ? query.eq('id', attemptId) : query.eq('week_start', weekStart);
  return check(await query.maybeSingle());
}

async function recordQuizComplete(email, ageGroup, { attemptId, weekStart }, today) {
  const attempt = await findAttempt(email, ageGroup, { attemptId, weekStart });
  if (!attempt) return { notFound: true };

  const before = await getProgressRow(email, ageGroup);
  const reward = quizRewards(before, attempt.percentage);
  const claimed = check(await supabase.from('ca_quiz_attempts')
    .update({ points_awarded: true, points_earned: reward.points })
    .eq('id', attempt.id).eq('points_awarded', false)
    .select());
  if (!claimed?.length) {
    return {
      alreadyRecorded: true, pointsAwarded: 0, newBadges: [],
      percentage: attempt.percentage, excellence: attempt.percentage >= EXCELLENCE_PERCENT,
      progress: toProgress(before, email, ageGroup, today),
    };
  }

  let row;
  try {
    row = await applyProgress({
      p_student_email: email, p_age_group: ageGroup,
      p_points: reward.points, p_quizzes: 1,
      p_quiz_score: attempt.percentage, p_last_quiz_date: today,
      p_badge_excellence: reward.excellence, p_badge_growth: reward.growth,
    });
  } catch (e) {
    await undo(supabase.from('ca_quiz_attempts').update({ points_awarded: false, points_earned: 0 }).eq('id', attempt.id));
    throw e;
  }
  return {
    alreadyRecorded: false, pointsAwarded: reward.points, newBadges: reward.newBadges,
    percentage: attempt.percentage, excellence: reward.excellence, growth: reward.growth,
    progress: toProgress(row, email, ageGroup, today),
  };
}

module.exports = { getProgress, toProgress, recordDigestComplete, recordStoryRead, recordQuizComplete };
