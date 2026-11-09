// In-memory stand-in for the supabase-js client, covering just the calls this
// service makes: from().select/eq/in/lte/order/limit/maybeSingle, upsert with
// ignoreDuplicates, update, delete, and rpc('ca_apply_progress') — which mirrors
// the SQL function in schema.sql.
const crypto = require('crypto');

const UNIQUE_KEYS = {
  ca_digest_views: ['student_email', 'view_date'],
  ca_story_reads: ['student_email', 'story_id'],
  ca_quiz_attempts: ['student_email', 'age_group', 'week_start'],
  ca_progress: ['student_email', 'age_group'],
};

function createFakeSupabase() {
  let tables = {};
  const calls = [];

  const table = (name) => (tables[name] = tables[name] || []);

  class Query {
    constructor(name) {
      this.name = name;
      this.filters = [];
      this.orders = [];
      this.max = null;
      this.mode = 'select';
      this.payload = null;
      this.options = {};
      this.single = false;
      this.returning = false;
    }
    select() { if (this.mode !== 'select') this.returning = true; return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
    lte(col, val) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] <= val); return this; }
    gte(col, val) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] >= val); return this; }
    order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this; }
    limit(n) { this.max = n; return this; }
    maybeSingle() { this.single = true; return this; }
    upsert(row, options = {}) { this.mode = 'upsert'; this.payload = row; this.options = options; return this; }
    insert(row) { this.mode = 'upsert'; this.payload = row; this.options = {}; return this; }
    update(patch) { this.mode = 'update'; this.payload = patch; return this; }
    delete() { this.mode = 'delete'; return this; }

    matches(r) { return this.filters.every((f) => f(r)); }

    run() {
      calls.push({ table: this.name, mode: this.mode, payload: this.payload, options: this.options });
      const rows = table(this.name);
      if (this.mode === 'upsert') {
        const keys = UNIQUE_KEYS[this.name];
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = [];
        for (const item of list) {
          const clash = keys && rows.find((r) => keys.every((k) => r[k] === item[k]));
          if (clash) {
            if (!this.options.ignoreDuplicates) Object.assign(clash, item);
            continue;
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), points_awarded: false, ...item };
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted, error: null };
      }
      if (this.mode === 'update') {
        const hit = rows.filter((r) => this.matches(r));
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (this.mode === 'delete') {
        tables[this.name] = rows.filter((r) => !this.matches(r));
        return { data: null, error: null };
      }
      let out = rows.filter((r) => this.matches(r)).map((r) => ({ ...r }));
      for (const { col, ascending } of [...this.orders].reverse()) {
        out.sort((a, b) => {
          if (a[col] === b[col]) return 0;
          return (a[col] > b[col] ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (this.max !== null) out = out.slice(0, this.max);
      if (this.single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }

    then(resolve, reject) {
      try { return Promise.resolve(this.run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
    }
  }

  const max = (a, b) => (a === null || a === undefined ? b : b === null || b === undefined ? a : a > b ? a : b);

  function applyProgress(p) {
    const rows = table('ca_progress');
    const email = p.p_student_email.toLowerCase().trim();
    let row = rows.find((r) => r.student_email === email && r.age_group === p.p_age_group);
    if (!row) {
      row = {
        student_email: email, age_group: p.p_age_group, points: 0, current_streak: 0, longest_streak: 0,
        digests_completed: 0, stories_read: 0, quizzes_completed: 0, best_quiz_score: null, last_quiz_score: null,
        badge_excellence: false, badge_weekly_streak: false, badge_growth: false,
        last_digest_date: null, last_story_date: null, last_quiz_date: null,
      };
      rows.push(row);
    }
    row.points += p.p_points || 0;
    row.digests_completed += p.p_digests || 0;
    row.stories_read += p.p_stories || 0;
    row.quizzes_completed += p.p_quizzes || 0;
    if (p.p_current_streak !== undefined && p.p_current_streak !== null) row.current_streak = p.p_current_streak;
    row.longest_streak = Math.max(row.longest_streak, p.p_current_streak || 0);
    row.last_digest_date = max(row.last_digest_date, p.p_last_digest_date);
    row.last_story_date = max(row.last_story_date, p.p_last_story_date);
    row.best_quiz_score = max(row.best_quiz_score, p.p_quiz_score);
    if (p.p_quiz_score !== undefined && p.p_quiz_score !== null) row.last_quiz_score = p.p_quiz_score;
    row.last_quiz_date = max(row.last_quiz_date, p.p_last_quiz_date);
    row.badge_excellence = row.badge_excellence || !!p.p_badge_excellence;
    row.badge_weekly_streak = row.badge_weekly_streak || !!p.p_badge_weekly_streak;
    row.badge_growth = row.badge_growth || !!p.p_badge_growth;
    row.updated_at = new Date().toISOString();
    return { ...row };
  }

  const client = {
    from: (name) => new Query(name),
    rpc: jest.fn(async (fn, params) => {
      calls.push({ rpc: fn, params });
      if (fn === 'ca_apply_progress') return { data: applyProgress(params), error: null };
      return { data: null, error: { message: `unknown function ${fn}` } };
    }),
    // test helpers
    __seed(name, rows) { table(name).push(...rows.map((r) => ({ ...r }))); },
    __rows(name) { return table(name); },
    __calls: calls,
    __reset() { tables = {}; calls.length = 0; client.rpc.mockClear(); },
  };
  return client;
}

module.exports = { createFakeSupabase };
