// Points, streaks and badges (PRD §5). Pure functions — the database write
// itself is the atomic ca_apply_progress() function in schema.sql.

const { daysBetween } = require('./content');

const POINTS = { digest: 10, story: 5, quiz: 20, excellenceBonus: 10 };
const EXCELLENCE_PERCENT = 80;
const WEEKLY_STREAK_DAYS = 7;

// Streak after completing the digest on `today`.
function nextStreak(lastDigestDate, currentStreak, today) {
  if (!lastDigestDate) return 1;
  const gap = daysBetween(lastDigestDate, today);
  if (gap <= 0) return Math.max(currentStreak || 0, 1); // same day (or clock skew): unchanged
  if (gap === 1) return (currentStreak || 0) + 1;
  return 1;
}

// Streak to show: a streak whose last day was before yesterday has lapsed.
function displayedStreak(lastDigestDate, currentStreak, today) {
  if (!lastDigestDate) return 0;
  return daysBetween(lastDigestDate, today) <= 1 ? currentStreak || 0 : 0;
}

function digestRewards(progress, today) {
  const streak = nextStreak(progress?.last_digest_date, progress?.current_streak, today);
  const weeklyStreak = streak >= WEEKLY_STREAK_DAYS;
  return {
    points: POINTS.digest,
    streak,
    weeklyStreak,
    newBadges: weeklyStreak && !progress?.badge_weekly_streak ? ['weekly_streak'] : [],
  };
}

function quizRewards(progress, percentage) {
  const excellence = percentage >= EXCELLENCE_PERCENT;
  const previous = progress?.last_quiz_score;
  const growth = previous !== null && previous !== undefined && percentage > previous;
  const newBadges = [];
  if (excellence && !progress?.badge_excellence) newBadges.push('excellence');
  if (growth && !progress?.badge_growth) newBadges.push('growth');
  return {
    points: POINTS.quiz + (excellence ? POINTS.excellenceBonus : 0),
    excellence,
    growth,
    newBadges,
  };
}

module.exports = {
  POINTS, EXCELLENCE_PERCENT, WEEKLY_STREAK_DAYS,
  nextStreak, displayedStreak, digestRewards, quizRewards,
};
