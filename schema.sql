-- ============================================================================
-- Aivorah Current Affairs — Supabase schema
-- Run the whole file in the Supabase SQL editor. Safe to re-run: tables,
-- indexes and seed rows are created only if missing; functions and policies
-- are replaced.
--
-- Tables
--   ca_stories          news stories, 3 age versions each (status-gated)
--   ca_quiz_questions   weekly quiz questions incl. correct answers (status-gated,
--                       never readable by students directly)
--   ca_digest_views     one row per student per day the digest was completed
--   ca_story_reads      one row per student per story read
--   ca_quiz_attempts    one weekly quiz attempt per student / age group / week
--   ca_progress         points, streaks, counts, badges per student + age group
-- ============================================================================

create extension if not exists pgcrypto;

-- ── Stories ─────────────────────────────────────────────────────────────────
create table if not exists ca_stories (
  id                  uuid primary key default gen_random_uuid(),
  category            text not null
                      check (category in ('india','world','economy','science','environment','sports','society')),
  publish_date        date not null default current_date,
  -- review = waiting for an editor (everything the pipeline writes)
  -- published = visible in the app; rejected/archived = never shown
  status              text not null default 'review'
                      check (status in ('draft','review','published','rejected','archived')),
  priority            integer not null default 0,           -- higher shows first

  title_young         text not null,                        -- under-8
  title_kid           text not null,                        -- 8-12
  title_teen          text not null,                        -- 13+
  summary_young       text not null,
  summary_kid         text not null,
  summary_teen        text not null,
  what_happened_young text not null,
  what_happened_kid   text not null,
  what_happened_teen  text not null,
  why_important_young text not null,
  why_important_kid   text not null,
  why_important_teen  text not null,

  -- Shared across age groups. under-8 shows word 1 only, 8-12 words 1-2, 13+ words 1-3.
  did_you_know        text,
  new_word_1          text,
  def_1               text,
  new_word_2          text,
  def_2               text,
  new_word_3          text,
  def_3               text,
  think_about_it      text,
  -- Optional per-age overrides written by the pipeline:
  -- {"young": {"didYouKnow": "", "thinkAboutIt": "", "newWords": [{"word": "", "definition": ""}]}, "kid": {...}, "teen": {...}}
  age_extras          jsonb not null default '{}'::jsonb,

  image_url           text,
  source              text not null,                        -- e.g. 'PIB', 'NASA'
  source_url          text,
  source_url_hash     text,                                 -- sha256 of the normalised URL (pipeline dedupe)
  -- true only once an editor has checked the facts against the source
  is_true_fact        boolean not null default false,
  review_notes        text,                                 -- pipeline flags for the editor

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ca_stories_published_idx
  on ca_stories (publish_date desc, priority desc) where status = 'published';
create unique index if not exists ca_stories_source_url_hash_key
  on ca_stories (source_url_hash) where source_url_hash is not null;

-- ── Quiz questions ──────────────────────────────────────────────────────────
-- week_start is the Sunday the quiz is released; that quiz is played until the
-- next Saturday. 10 per age group per week: 6 mcq, 2 true_false, 2 reasoning,
-- 2 each from India / World / Science / Economy+Environment / Sports+Society.
create table if not exists ca_quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  week_start     date not null,
  age_group      text not null check (age_group in ('under-8','8-12','13+')),
  category       text not null
                 check (category in ('india','world','economy','science','environment','sports','society')),
  question_type  text not null default 'mcq' check (question_type in ('mcq','true_false','reasoning')),
  question       text not null,
  options        jsonb not null,                            -- ["A", "B", "C", "D"] or ["True", "False"]
  correct_index  integer not null check (correct_index >= 0),
  explanation    text not null,
  extra_fact     text,
  story_id       uuid references ca_stories(id) on delete set null,
  status         text not null default 'review'
                 check (status in ('draft','review','published','rejected','archived')),
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  check (jsonb_typeof(options) = 'array' and correct_index < jsonb_array_length(options))
);

create index if not exists ca_quiz_questions_week_idx
  on ca_quiz_questions (week_start, age_group) where status = 'published';

-- ── Student activity ────────────────────────────────────────────────────────
create table if not exists ca_digest_views (
  id            uuid primary key default gen_random_uuid(),
  student_email text not null,
  age_group     text not null check (age_group in ('under-8','8-12','13+')),
  view_date     date not null,
  story_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (student_email, view_date)
);

create table if not exists ca_story_reads (
  id               uuid primary key default gen_random_uuid(),
  student_email    text not null,
  story_id         uuid not null references ca_stories(id) on delete cascade,
  age_group        text not null check (age_group in ('under-8','8-12','13+')),
  read_date        date not null default current_date,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  created_at       timestamptz not null default now(),
  unique (student_email, story_id)
);

create table if not exists ca_quiz_attempts (
  id             uuid primary key default gen_random_uuid(),
  student_email  text not null,
  age_group      text not null check (age_group in ('under-8','8-12','13+')),
  week_start     date not null,
  answers        jsonb not null default '[]'::jsonb,        -- [{questionId, selected, correctIndex, correct}]
  score          integer not null default 0,
  total          integer not null default 0,
  percentage     integer not null default 0,
  points_earned  integer not null default 0,
  points_awarded boolean not null default false,            -- set once by /progress/quiz-complete
  created_at     timestamptz not null default now(),
  unique (student_email, age_group, week_start)
);

create table if not exists ca_progress (
  student_email       text not null,
  age_group           text not null check (age_group in ('under-8','8-12','13+')),
  points              integer not null default 0,
  current_streak      integer not null default 0,
  longest_streak      integer not null default 0,
  digests_completed   integer not null default 0,
  stories_read        integer not null default 0,
  quizzes_completed   integer not null default 0,
  best_quiz_score     integer,                              -- best percentage
  last_quiz_score     integer,                              -- latest percentage (growth badge)
  badge_excellence    boolean not null default false,       -- a quiz at 80%+
  badge_weekly_streak boolean not null default false,       -- 7 days in a row
  badge_growth        boolean not null default false,       -- beat the previous quiz score
  last_digest_date    date,
  last_story_date     date,
  last_quiz_date      date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (student_email, age_group)
);

-- ── updated_at on stories ───────────────────────────────────────────────────
create or replace function ca_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ca_stories_touch on ca_stories;
create trigger ca_stories_touch before update on ca_stories
  for each row execute function ca_touch_updated_at();

-- ── Atomic progress update ──────────────────────────────────────────────────
-- One statement: creates the row if missing, otherwise adds the increments
-- (points + counters), keeps the larger dates / best score, sets badges once
-- earned (never unsets them). Called by the service via supabase.rpc().
create or replace function ca_apply_progress(
  p_student_email       text,
  p_age_group           text,
  p_points              integer default 0,
  p_digests             integer default 0,
  p_stories             integer default 0,
  p_quizzes             integer default 0,
  p_current_streak      integer default null,
  p_last_digest_date    date    default null,
  p_last_story_date     date    default null,
  p_quiz_score          integer default null,
  p_last_quiz_date      date    default null,
  p_badge_excellence    boolean default false,
  p_badge_weekly_streak boolean default false,
  p_badge_growth        boolean default false
) returns ca_progress
language sql
as $$
  insert into ca_progress as p (
    student_email, age_group, points, digests_completed, stories_read, quizzes_completed,
    current_streak, longest_streak, last_digest_date, last_story_date,
    best_quiz_score, last_quiz_score, last_quiz_date,
    badge_excellence, badge_weekly_streak, badge_growth
  ) values (
    lower(trim(p_student_email)), p_age_group,
    greatest(coalesce(p_points, 0), 0), greatest(coalesce(p_digests, 0), 0),
    greatest(coalesce(p_stories, 0), 0), greatest(coalesce(p_quizzes, 0), 0),
    coalesce(p_current_streak, 0), coalesce(p_current_streak, 0),
    p_last_digest_date, p_last_story_date,
    p_quiz_score, p_quiz_score, p_last_quiz_date,
    coalesce(p_badge_excellence, false), coalesce(p_badge_weekly_streak, false), coalesce(p_badge_growth, false)
  )
  on conflict (student_email, age_group) do update set
    points              = p.points + excluded.points,
    digests_completed   = p.digests_completed + excluded.digests_completed,
    stories_read        = p.stories_read + excluded.stories_read,
    quizzes_completed   = p.quizzes_completed + excluded.quizzes_completed,
    current_streak      = coalesce(p_current_streak, p.current_streak),
    longest_streak      = greatest(p.longest_streak, coalesce(p_current_streak, 0)),
    last_digest_date    = greatest(p.last_digest_date, excluded.last_digest_date),
    last_story_date     = greatest(p.last_story_date, excluded.last_story_date),
    best_quiz_score     = greatest(p.best_quiz_score, excluded.best_quiz_score),
    last_quiz_score     = coalesce(p_quiz_score, p.last_quiz_score),
    last_quiz_date      = greatest(p.last_quiz_date, excluded.last_quiz_date),
    badge_excellence    = p.badge_excellence or excluded.badge_excellence,
    badge_weekly_streak = p.badge_weekly_streak or excluded.badge_weekly_streak,
    badge_growth        = p.badge_growth or excluded.badge_growth,
    updated_at          = now()
  returning *;
$$;

-- Only the service (service_role key) may call it.
revoke all on function ca_apply_progress(text, text, integer, integer, integer, integer, integer, date, date, integer, date, boolean, boolean, boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function ca_apply_progress(text, text, integer, integer, integer, integer, integer, date, date, integer, date, boolean, boolean, boolean) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ca_apply_progress(text, text, integer, integer, integer, integer, integer, date, date, integer, date, boolean, boolean, boolean) to service_role;
  end if;
end $$;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- See SETUP.md: the service uses the service_role key, which bypasses RLS, and
-- students sign in with Firebase, not Supabase Auth. These policies only
-- matter for a client that queries Supabase directly with a Supabase JWT whose
-- `email` claim is the student's email. Points and quiz scores are never
-- writable by students — only the service changes ca_progress / ca_quiz_attempts.
alter table ca_stories        enable row level security;
alter table ca_quiz_questions enable row level security;   -- no policies: answers stay server-side
alter table ca_digest_views   enable row level security;
alter table ca_story_reads    enable row level security;
alter table ca_quiz_attempts  enable row level security;
alter table ca_progress       enable row level security;

drop policy if exists ca_stories_read_published on ca_stories;
create policy ca_stories_read_published on ca_stories
  for select to anon, authenticated
  using (status = 'published');

drop policy if exists ca_progress_select_own on ca_progress;
create policy ca_progress_select_own on ca_progress
  for select to authenticated
  using (student_email = lower(auth.jwt() ->> 'email'));

drop policy if exists ca_quiz_attempts_select_own on ca_quiz_attempts;
create policy ca_quiz_attempts_select_own on ca_quiz_attempts
  for select to authenticated
  using (student_email = lower(auth.jwt() ->> 'email'));

drop policy if exists ca_digest_views_select_own on ca_digest_views;
create policy ca_digest_views_select_own on ca_digest_views
  for select to authenticated
  using (student_email = lower(auth.jwt() ->> 'email'));

drop policy if exists ca_digest_views_insert_own on ca_digest_views;
create policy ca_digest_views_insert_own on ca_digest_views
  for insert to authenticated
  with check (student_email = lower(auth.jwt() ->> 'email'));

drop policy if exists ca_story_reads_select_own on ca_story_reads;
create policy ca_story_reads_select_own on ca_story_reads
  for select to authenticated
  using (student_email = lower(auth.jwt() ->> 'email'));

drop policy if exists ca_story_reads_insert_own on ca_story_reads;
create policy ca_story_reads_insert_own on ca_story_reads
  for insert to authenticated
  with check (student_email = lower(auth.jwt() ->> 'email'));

-- ── Seed data ───────────────────────────────────────────────────────────────
-- 3 hand-written, fact-checked demo stories for today, plus a 10-question 8-12
-- quiz for this week, so the endpoints return something straight away.
-- Fixed ids: re-running the file never duplicates them.
insert into ca_stories (
  id, category, publish_date, status, priority,
  title_young, title_kid, title_teen,
  summary_young, summary_kid, summary_teen,
  what_happened_young, what_happened_kid, what_happened_teen,
  why_important_young, why_important_kid, why_important_teen,
  did_you_know, new_word_1, def_1, new_word_2, def_2, new_word_3, def_3, think_about_it,
  source, source_url, is_true_fact
) values
(
  '6f1c2a10-0000-4000-8000-000000000001', 'india', current_date, 'published', 30,
  'India Landed on the Moon!',
  'India and Space Exploration: Chandrayaan-3',
  'Chandrayaan-3: How India Reached the Moon''s South Pole',
  'India sent a small machine all the way to the Moon, and it landed safely.',
  'India''s Chandrayaan-3 mission landed near the Moon''s south pole, a place no country had landed before.',
  'Chandrayaan-3 made India the first country to soft-land near the lunar south pole and the fourth to land on the Moon at all.',
  'India''s space team, ISRO, sent a spacecraft called Chandrayaan-3 to the Moon. On 23 August 2023 it landed very gently. A tiny rover rolled out and looked at the Moon''s ground.',
  'ISRO, India''s space agency, launched Chandrayaan-3 in July 2023. On 23 August 2023 its lander, Vikram, touched down softly near the Moon''s south pole. A small rover called Pragyan then drove out and studied the soil around it.',
  'ISRO launched Chandrayaan-3 in July 2023. On 23 August 2023 the Vikram lander made a controlled soft landing near the lunar south pole, and the Pragyan rover drove out to study the surface. Only the USA, the former Soviet Union and China had soft-landed on the Moon before, and none of them near the south pole.',
  'It shows that India can do very hard space work, and it helps us learn about the Moon.',
  'It shows India can do very difficult space missions. Scientists want to learn about the south pole because some places there are always in shadow and may hold frozen water.',
  'The south pole region has craters that never see sunlight and may hold water ice, which future missions could use for drinking water, oxygen or rocket fuel. The landing also put India among the leading space nations and gives its space industry more trust worldwide.',
  'India now celebrates National Space Day every year on 23 August, the day Chandrayaan-3 landed.',
  'Rover', 'A small vehicle that moves around on the surface of a planet or the Moon to explore it.',
  'Lunar', 'Anything to do with the Moon.',
  'Soft landing', 'Landing a spacecraft slowly and gently so it is not damaged.',
  'If you could send a rover anywhere in space, where would you send it and what would you look for?',
  'ISRO', 'https://www.isro.gov.in/Chandrayaan3_Details.html', true
),
(
  '6f1c2a10-0000-4000-8000-000000000002', 'world', current_date, 'published', 20,
  'Thousands of New Sea Animals!',
  'Scientists Find Thousands of Unknown Deep-Sea Animals',
  'A Deep-Sea Survey Finds Over 5,000 Species, Most Unknown to Science',
  'Scientists looked deep in the ocean and found many animals nobody had seen before.',
  'A study of the deep Pacific Ocean counted over 5,000 kinds of animals, and most were new to science.',
  'Researchers listed 5,578 species in a Pacific region being explored for mining, and about 9 in 10 had never been described.',
  'Far away in the Pacific Ocean, the sea floor is very deep and dark. Scientists studied it and found more than 5,000 kinds of animals. Most of them were brand new to science!',
  'Scientists studied a huge, deep part of the Pacific Ocean called the Clarion-Clipperton Zone. In a 2023 study they counted 5,578 different species living on the dark sea floor. Around 9 out of every 10 had never been named or described before.',
  'A 2023 study in the journal Current Biology brought together decades of samples from the Clarion-Clipperton Zone, a wide stretch of the Pacific sea floor between Hawaii and Mexico. It listed 5,578 species, and roughly 88 to 92 percent of them had never been formally described by scientists. The area is rich in metal-bearing rocks called nodules, which companies want to mine.',
  'There is still so much to discover on our planet, and we need to look after the ocean.',
  'Companies want to mine metals from this sea floor. Knowing which animals live there helps people decide how to protect them before any mining starts.',
  'The metals in these nodules, such as nickel and cobalt, are used in batteries, so there is pressure to mine them. Without knowing what lives there, nobody can judge how much damage mining might cause. The study is a starting point for rules that balance resources and nature.',
  'More people have walked on the Moon than have visited the deepest parts of the ocean.',
  'Species', 'A group of living things of the same kind that can have young ones together.',
  'Deep sea', 'The very deep, dark and cold part of the ocean where sunlight cannot reach.',
  'Biodiversity', 'The variety of all the different kinds of plants and animals in a place.',
  'Why do you think so many animals in the deep sea are still unknown?',
  'Current Biology (Rabone et al., 2023)', 'https://doi.org/10.1016/j.cub.2023.04.052', true
),
(
  '6f1c2a10-0000-4000-8000-000000000003', 'science', current_date, 'published', 10,
  'Robots That Help Doctors',
  'How Robots Help Surgeons Do Operations',
  'Robot-Assisted Surgery: Smaller Cuts, Faster Recovery',
  'Some doctors use a robot helper to make operations safer and smaller.',
  'In robot-assisted surgery, a surgeon controls robot arms that hold tiny tools, so the cuts are small.',
  'Robotic surgery lets a surgeon guide precise robotic instruments from a console, often through much smaller incisions than open surgery.',
  'In some hospitals, doctors use a robot to help with operations. The doctor moves the robot''s arms from a special desk. The robot holds very small tools.',
  'In robot-assisted surgery, the surgeon sits at a computer station and controls robot arms. Small tools and a tiny camera go into the body through small cuts. The robot copies the surgeon''s hand movements very precisely.',
  'In robotic surgery the surgeon works from a console and directs robotic arms holding small instruments, while a thin camera called a laparoscope gives an enlarged 3-D view. The robot copies the surgeon''s hand movements with fine precision. It is used for operations such as kidney, heart-valve and gallbladder surgery, and it is becoming more common, though setting up the robot can make an operation take longer.',
  'Smaller cuts can mean less pain and getting better faster.',
  'Small cuts usually mean less pain, less bleeding, smaller scars and a shorter stay in hospital for patients.',
  'Benefits include faster recovery, less pain and bleeding, lower risk of infection, shorter hospital stays and smaller scars. It is not always the best choice, and not every hospital has a robot, so access and cost are important questions for health systems.',
  'The robot never works on its own: a trained surgeon controls every move.',
  'Surgeon', 'A doctor who does operations.',
  'Precise', 'Very exact and careful, with no mistakes.',
  'Console', 'A desk with controls that a person uses to operate a machine.',
  'What other jobs do you think robots could help people with?',
  'MedlinePlus (U.S. National Library of Medicine)', 'https://medlineplus.gov/ency/article/007339.htm', true
)
on conflict (id) do nothing;

-- This week's quiz (released on the most recent Sunday) for 8-12.
insert into ca_quiz_questions (
  id, week_start, age_group, category, question_type, question, options, correct_index,
  explanation, extra_fact, story_id, status, position
) values
('7a2d3b20-0000-4000-8000-000000000001', current_date - extract(dow from current_date)::int, '8-12', 'india', 'mcq',
 'Near which part of the Moon did Chandrayaan-3 land?',
 '["The north pole", "The south pole", "The equator", "The far side"]', 1,
 'Chandrayaan-3''s Vikram lander touched down near the Moon''s south pole on 23 August 2023.',
 'The rover that drove out of the lander is called Pragyan, which means "wisdom" in Sanskrit.',
 '6f1c2a10-0000-4000-8000-000000000001', 'published', 1),
('7a2d3b20-0000-4000-8000-000000000002', current_date - extract(dow from current_date)::int, '8-12', 'india', 'true_false',
 'India celebrates National Space Day on 23 August.',
 '["True", "False"]', 0,
 'True. National Space Day marks the day Chandrayaan-3 landed on the Moon.',
 'India was the first country to land near the Moon''s south pole.',
 '6f1c2a10-0000-4000-8000-000000000001', 'published', 2),
('7a2d3b20-0000-4000-8000-000000000003', current_date - extract(dow from current_date)::int, '8-12', 'world', 'mcq',
 'In which ocean is the Clarion-Clipperton Zone?',
 '["Atlantic Ocean", "Indian Ocean", "Pacific Ocean", "Arctic Ocean"]', 2,
 'The Clarion-Clipperton Zone is a wide stretch of the Pacific sea floor between Hawaii and Mexico.',
 'The Pacific is the largest and deepest ocean on Earth.',
 '6f1c2a10-0000-4000-8000-000000000002', 'published', 3),
('7a2d3b20-0000-4000-8000-000000000004', current_date - extract(dow from current_date)::int, '8-12', 'world', 'reasoning',
 'Why do scientists want to study deep-sea animals before any mining starts there?',
 '["So people know what could be harmed and can protect it", "Because mining makes every ocean warmer", "To find gold faster", "Because deep-sea animals live on land"]', 0,
 'If we know which animals live there, we can judge how much harm mining might cause and make rules to protect them.',
 'About 9 in 10 of the species found in the study had never been described before.',
 '6f1c2a10-0000-4000-8000-000000000002', 'published', 4),
('7a2d3b20-0000-4000-8000-000000000005', current_date - extract(dow from current_date)::int, '8-12', 'science', 'mcq',
 'Who controls a surgical robot during an operation?',
 '["The robot decides by itself", "A trained surgeon", "The patient", "A video game player"]', 1,
 'The surgeon sits at a console and controls every movement of the robot''s arms.',
 'A thin camera called a laparoscope shows the surgeon an enlarged 3-D view inside the body.',
 '6f1c2a10-0000-4000-8000-000000000003', 'published', 5),
('7a2d3b20-0000-4000-8000-000000000006', current_date - extract(dow from current_date)::int, '8-12', 'science', 'true_false',
 'Robot-assisted surgery usually needs one very large cut.',
 '["True", "False"]', 1,
 'False. The tools go in through small cuts, which is why patients often recover faster.',
 'Smaller cuts can also mean smaller scars and less risk of infection.',
 '6f1c2a10-0000-4000-8000-000000000003', 'published', 6),
('7a2d3b20-0000-4000-8000-000000000007', current_date - extract(dow from current_date)::int, '8-12', 'economy', 'mcq',
 'Which organisation is India''s central bank?',
 '["SEBI", "Reserve Bank of India (RBI)", "ISRO", "NITI Aayog"]', 1,
 'The Reserve Bank of India manages the country''s money and issues banknotes.',
 'The RBI was set up in 1935.',
 null, 'published', 7),
('7a2d3b20-0000-4000-8000-000000000008', current_date - extract(dow from current_date)::int, '8-12', 'environment', 'mcq',
 'Which gas do trees take in from the air to make their food?',
 '["Oxygen", "Carbon dioxide", "Nitrogen", "Helium"]', 1,
 'Trees use carbon dioxide, water and sunlight to make food. This is called photosynthesis.',
 'Because trees take in carbon dioxide, planting and protecting forests helps fight climate change.',
 null, 'published', 8),
('7a2d3b20-0000-4000-8000-000000000009', current_date - extract(dow from current_date)::int, '8-12', 'sports', 'mcq',
 'How often are the Summer Olympic Games usually held?',
 '["Every year", "Every 2 years", "Every 4 years", "Every 10 years"]', 2,
 'The Summer Olympics are usually held every four years, in a different city each time.',
 'The modern Olympic Games began in Athens, Greece, in 1896.',
 null, 'published', 9),
('7a2d3b20-0000-4000-8000-000000000010', current_date - extract(dow from current_date)::int, '8-12', 'society', 'reasoning',
 'Why might a country count how many children go to school each year?',
 '["To plan enough schools and teachers", "To decide the weather", "To choose cricket teams", "To make roads longer"]', 0,
 'Knowing how many children are in school helps the government plan classrooms, teachers and books.',
 'Counting people and services like this is part of how countries make plans and budgets.',
 null, 'published', 10)
on conflict (id) do nothing;

-- Tell the Supabase API (PostgREST) about the new tables and function right away.
notify pgrst, 'reload schema';
