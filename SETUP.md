# Current Affairs service — setup

## 1. Create the tables

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the whole of `schema.sql` and click **Run**. It is safe to run again later:
   tables, indexes and seed rows are only created when missing; the function and
   policies are replaced.

### Check the tables exist

```sql
select table_name
from information_schema.tables
where table_schema = 'public' and table_name like 'ca\_%'
order by table_name;
```

You should see 6 tables: the 5 from the PRD (`ca_stories`, `ca_digest_views`,
`ca_story_reads`, `ca_quiz_attempts`, `ca_progress`) plus `ca_quiz_questions`,
which holds the weekly quiz (the PRD lists no table for it, but the quiz needs
its questions and answers stored somewhere students cannot read them).

### Check the seed data

```sql
select category, publish_date, status, title_kid from ca_stories order by priority desc;
-- 3 rows: india, world, science — published today

select week_start, age_group, category, question_type, question
from ca_quiz_questions order by position;
-- 10 rows for 8-12: this week's quiz (week_start = the most recent Sunday)
```

The seed quiz exists only for **8-12** and only for the week you ran the file, so
under-8 / 13+ (and later weeks) show the "no quiz yet" screen until the quiz
pipeline has run and an editor has published questions.

## 2. Environment

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL`, `SUPABASE_KEY` (the **service_role** key, from Project
Settings → API), `FIREBASE_SERVICE_ACCOUNT_B64` and, for the content pipeline,
`GROQ_API_KEY`. For local work without Firebase credentials set
`AUTH_ENFORCE=monitor` (requests that would be refused are only logged). Never
use `monitor` on Render.

## 3. Run it

```bash
npm install && npm start
```

The log should say `Aivorah Current Affairs service running on port 3024`.

> The spec asked for port 3015, but `aivorah-assignments-service` already uses
> 3015 locally (and the frontend's local URL for it), so this service defaults to
> **3024**. On Render the port comes from `PORT`, so this only matters locally.

## 4. Try the endpoints

```bash
curl http://localhost:3024/health
curl "http://localhost:3024/current-affairs/digest/today?ageGroup=8-12"
curl "http://localhost:3024/current-affairs/quiz/week?ageGroup=8-12"
```

Expect `{"status":"ok",...}`, a digest with the 3 seed stories, and a quiz with 10
questions (no answers in it). Write `13+` as `13%2B` in a URL (a bare `+` means a
space — the service accepts that too).

Endpoints that act on one student (`studentEmail`) need that student's Firebase ID
token: `-H "Authorization: Bearer <token>"`. The app sends it automatically.

| Method | Path | Notes |
|---|---|---|
| GET | `/current-affairs/digest/today?ageGroup&studentEmail&date` | 3 / 10 / 18 stories; latest digest if none today |
| GET | `/current-affairs/digest/list?limit=30` | past digest dates + story counts |
| GET | `/current-affairs/story/:id?ageGroup` | one published story |
| GET | `/current-affairs/quiz/week?ageGroup&studentEmail&weekStart` | 10 questions, no answers; the student's attempt if taken |
| POST | `/current-affairs/quiz/check` | `{questionId, answer}` → correct answer, explanation, extra fact |
| POST | `/current-affairs/quiz/submit` | `{studentEmail, ageGroup, answers:[{questionId, answer}], weekStart?}` — graded on the server, 1 per week |
| GET | `/current-affairs/progress/:studentEmail?ageGroup` | points, streaks, badges |
| POST | `/current-affairs/progress/digest-complete` | +10, once a day; streak; weekly-streak badge at 7 days |
| POST | `/current-affairs/progress/story-read` | +5, once per story |
| POST | `/current-affairs/progress/quiz-complete` | +20; +10 and excellence badge at 80%+; growth badge when beating the last quiz |

## 5. Content pipeline and review

Nothing the pipeline writes is shown to students until an editor publishes it.

```bash
npm run generate:digest -- --dry-run     # fetch + write, save nothing (see logs/)
npm run generate:digest                  # daily: saves stories with status 'review'
npm run generate:quiz                    # Sundays: 10 questions per age group, status 'review'
```

Sources are only those in `scripts/lib/sources.js` (PRD §6.1). On 2026-11-09 the
working feeds were The Hindu, The Indian Express, BBC World, RBI, NASA and WHO.
PIB, Nature, Reuters, AP, World Bank, IMF, ISRO, UNEP, IPCC, UNESCO, UNICEF and
the sports federations are listed but switched off, each with the reason (no
public feed, licence needed, or the site blocks scripts). **Environment and
Sports have no working source yet**, so those categories stay empty until one is
approved and enabled. Every action is logged to `logs/<script>-<date>.jsonl`.

### Reviewing content

```sql
-- Stories waiting for review, with the pipeline's flags
select id, category, title_kid, source, source_url, review_notes
from ca_stories where status = 'review' order by created_at desc;

-- After checking a story against its source
update ca_stories set status = 'published', is_true_fact = true where id = '...';
-- or: set status = 'rejected'

-- This week's quiz for one age group
update ca_quiz_questions set status = 'published'
where week_start = '2026-11-08' and age_group = '8-12' and status = 'review';
```

`review_notes` lists what the automatic check could not confirm: numbers or names
in the text that are not in the source, word counts outside the age range, and
"did you know" facts (always flagged — they come from outside the source).

## Security: what RLS does and doesn't protect

- Students sign in with **Firebase**, not Supabase Auth, and this service connects
  with the **service_role** key, which **bypasses RLS entirely**.
- So the RLS policies in `schema.sql` only apply to a client that queries Supabase
  directly with a Supabase JWT whose `email` claim is the student's. Today no
  client does that. They are a safety net, not the main protection:
  - stories: anyone may read **published** stories only;
  - progress, quiz attempts, digest views, story reads: a student may read only
    rows with their own email; they may insert their own digest views and story
    reads;
  - students can **never** write `ca_progress` or `ca_quiz_attempts` (points and
    scores), even for their own email — only the service changes those, through
    the `ca_apply_progress()` function, which only `service_role` may call;
  - `ca_quiz_questions` has no student policy at all, so answers never leak.
- The real protection is in the service (`middleware/auth.js`): every request
  about a student must carry that student's Firebase ID token, and the token's
  email must equal the `studentEmail` in the request; queries are always filtered
  by that email. Quiz scores are graded on the server and points are taken from
  the stored attempt, never from the request.

## Troubleshooting

- **Tables already exist from an earlier version.** `create table if not exists`
  leaves an existing table untouched, so new columns (for example `age_extras`,
  `new_word_3`, `source_url_hash`) are not added. Add them with
  `alter table ca_stories add column if not exists ...`, or, if the tables only
  hold test data, `drop table ca_story_reads, ca_digest_views, ca_quiz_attempts,
  ca_quiz_questions, ca_progress, ca_stories cascade;` and run `schema.sql` again.
- **`function ca_apply_progress does not exist`** — run `schema.sql` again; the
  points endpoints need it.
- **401/403 from progress endpoints** — the request has no Firebase token, or the
  token belongs to a different email. Locally, set `AUTH_ENFORCE=monitor`.
- **500 "Auth is not configured on this server"** — `FIREBASE_SERVICE_ACCOUNT_B64`
  is missing or not valid base64 JSON.
- **Digest shows yesterday's stories** — nothing is published for today yet; the
  service falls back to the latest published day (`isToday: false`).
