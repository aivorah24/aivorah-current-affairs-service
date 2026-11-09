const express = require('express');
const supabase = require('../services/supabase');
const { normalizeAgeGroup, toStory, isUuid } = require('../services/content');
const { check } = require('../services/db');
const { handle } = require('./helpers');

const router = express.Router();

// ── GET /current-affairs/story/:id?ageGroup=8-12 ────────────────────────────
// One published story in the age group's version (8-12 if ageGroup is missing).
router.get('/:id', handle(async (req, res) => {
  const ageGroup = req.query.ageGroup === undefined ? '8-12' : normalizeAgeGroup(req.query.ageGroup);
  if (!ageGroup) return res.status(400).json({ error: "ageGroup must be one of 'under-8', '8-12', '13+'" });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Story not found' });

  const row = check(await supabase.from('ca_stories').select('*')
    .eq('id', req.params.id).eq('status', 'published').maybeSingle());
  if (!row) return res.status(404).json({ error: 'Story not found' });

  res.json({ story: toStory(row, ageGroup) });
}));

module.exports = router;
