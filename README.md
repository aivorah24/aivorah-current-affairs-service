# Aivorah Current Affairs Service

Daily child-friendly news digest (3 / 10 / 18 stories for under-8 / 8-12 / 13+),
a weekly 10-question quiz, and points, streaks and badges. See `SETUP.md` for
database setup, endpoints, the content pipeline and the security model.

## Structure

```
index.js                 Express app (+ /health), routes under /current-affairs
routes/                  digest.js, story.js, quiz.js, progress.js (thin handlers)
services/
  content.js             age groups, dates (Asia/Kolkata), row → Story
  quiz.js                question selection (category/type mix) and grading
  rewards.js             points, streak and badge rules
  progress.js            progress reads/writes (gate row + ca_apply_progress RPC)
  supabase.js            Supabase client (service key)
  firebaseAdmin.js       verifies Firebase ID tokens
middleware/auth.js       a student may only read/change their own data
schema.sql               tables, RLS, ca_apply_progress(), seed data
scripts/                 generate-digest.js, generate-quiz.js (+ lib/)
tests/                   Jest + supertest, in-memory Supabase fake
```

## Commands

```bash
npm install
npm start                  # port 3024 locally (PORT on Render)
npm test
npm run generate:digest    # daily, saves stories for review
npm run generate:quiz      # Sundays, saves quiz questions for review
```

Env vars: see `.env.example`.

## Branching

`main` auto-deploys on Render. Work on a feature branch and open a PR.
