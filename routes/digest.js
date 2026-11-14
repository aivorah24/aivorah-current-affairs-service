const express = require('express');
const supabase = require('../services/supabase');
const { AGE_GROUPS, localDate, isDateString, toStory } = require('../services/content');
const { requireSelf } = require('../middleware/auth');
const { check } = require('../services/db');
const { readStudent, handle } = require('./helpers');

const router = express.Router();

// The latest day on or before `today` that has published stories.
async function latestDigestDate(today) {
  const rows = check(await supabase.from('ca_stories').select('publish_date')
    .eq('status', 'published').lte('publish_date', today)
    .order('publish_date', { ascending: false }).limit(1));
  return rows?.[0]?.publish_date || null;
}

// ── GET /current-affairs/digest/today?ageGroup=8-12&studentEmail=&date= ─────
// Today's stories for the age group (5 / 6 / 7). If nothing is published for
// today yet, the most recent digest is returned instead (isToday: false).
// With studentEmail, each story says whether that student has read it.
router.get('/today', requireSelf((req) => req.query.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, req.query, { emailRequired: false });
  if (!student) return;
  const { ageGroup, email } = student;
  const today = localDate();

  let date = req.query.date;
  if (date !== undefined) {
    if (!isDateString(date) || date > today) return res.status(400).json({ error: 'date must be YYYY-MM-DD, not in the future' });
  } else {
    date = await latestDigestDate(today);
  }

  const target = AGE_GROUPS[ageGroup].storiesPerDay;
  const rows = date
    ? check(await supabase.from('ca_stories').select('*')
      .eq('status', 'published').eq('publish_date', date)
      .order('priority', { ascending: false }).order('created_at', { ascending: true })
      .limit(target))
    : [];

  let readIds = new Set();
  let completed = false;
  if (email && rows.length) {
    const reads = check(await supabase.from('ca_story_reads').select('story_id')
      .eq('student_email', email).in('story_id', rows.map((r) => r.id)));
    readIds = new Set((reads || []).map((r) => r.story_id));
  }
  if (email) {
    const view = check(await supabase.from('ca_digest_views').select('id')
      .eq('student_email', email).eq('view_date', today).maybeSingle());
    completed = !!view;
  }

  const stories = rows.map((row) => ({ ...toStory(row, ageGroup), read: readIds.has(row.id) }));
  res.json({
    date,
    isToday: date === today,
    ageGroup,
    target,
    stories,
    readCount: stories.filter((s) => s.read).length,
    completed,
  });
}));

// ── GET /current-affairs/digest/list?limit=30 ───────────────────────────────
// Past digest dates (newest first) with how many stories each has.
router.get('/list', handle(async (req, res) => {
  const limit = Math.min(90, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const today = localDate();
  const rows = check(await supabase.from('ca_stories').select('publish_date')
    .eq('status', 'published').lte('publish_date', today)
    .order('publish_date', { ascending: false })
    .limit(limit * 30));

  const counts = new Map();
  for (const r of rows || []) counts.set(r.publish_date, (counts.get(r.publish_date) || 0) + 1);
  const dates = [...counts.entries()].slice(0, limit).map(([date, storyCount]) => ({ date, storyCount }));
  res.json({ dates });
}));

module.exports = router;
