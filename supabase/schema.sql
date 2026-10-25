-- Quiz App schema for Supabase  (v3: locked-down data + abuse limits)
-- Safe to run on a fresh project OR on top of v1/v2: it migrates the data and can be re-run.
-- Run the whole file in: Supabase Dashboard > SQL Editor.
--
-- WHO CAN READ THE DATA
--   * The tables live in the `private` schema. Supabase only exposes `public` through the API,
--     and the API roles (anon / authenticated) have no access to `private` at all.
--   * Row Level Security is also enabled on them (second lock; there are no policies).
--   * The browser can only call the 6 functions at the bottom. Passwords and the teacher key are
--     stored hashed, students never receive the correct answers, the server does the grading.
--
-- ABUSE / COST LIMITS (all tunable in private.cfg below)
--   * per-IP and global rate limits, brute-force lockout on quiz code + password
--   * hard caps: number of quizzes, attempts per quiz, quiz size, name/title lengths
--   * quizzes older than `retention_days` are deleted automatically (opportunistically, no cron)
--   * nothing here runs by itself: no pg_cron, no Edge Functions, no Realtime, no loops that can spin
--     (the API roles are also cut off by Supabase's default statement_timeout: anon = 3s)

-- ---------- schema + move old tables out of the exposed schema ----------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

do $$
begin
  if to_regclass('public.quizzes') is not null and to_regclass('private.quizzes') is null then
    alter table public.quizzes set schema private;
  end if;
  if to_regclass('public.quiz_attempts') is not null and to_regclass('private.quiz_attempts') is null then
    alter table public.quiz_attempts set schema private;
  end if;
end $$;

-- ---------- tables ----------
create table if not exists private.quizzes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  access_code text not null unique,
  password_hash text,
  teacher_key_hash text,
  duration_minutes integer not null default 30 check (duration_minutes between 1 and 240),
  questions jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists private.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references private.quizzes(id) on delete cascade,
  student_name text not null,
  score integer not null default 0,
  total integer not null,
  answers jsonb,
  started_at timestamptz not null default now(),
  submitted_at timestamptz not null default now()
);

create table if not exists private.rate_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  subject text not null,
  at timestamptz not null default now()
);

alter table private.quizzes add column if not exists password_hash text;
alter table private.quizzes add column if not exists teacher_key_hash text;
alter table private.quiz_attempts add column if not exists answers jsonb;

create index if not exists quiz_attempts_quiz_id_idx on private.quiz_attempts (quiz_id);
create index if not exists quizzes_created_at_idx on private.quizzes (created_at);
create index if not exists rate_events_lookup_idx on private.rate_events (bucket, subject, at desc);
create index if not exists rate_events_at_idx on private.rate_events (at);

-- ---------- migrate v1 (plain-text passwords) ----------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'private' and table_name = 'quizzes' and column_name = 'access_password') then
    update private.quizzes
       set password_hash = encode(sha256(convert_to(access_code || ':' || access_password, 'UTF8')), 'hex')
     where password_hash is null;
    alter table private.quizzes drop column access_password;
  end if;
end $$;

alter table private.quizzes alter column password_hash set not null;

alter table private.quizzes enable row level security;
alter table private.quiz_attempts enable row level security;
alter table private.rate_events enable row level security;

-- ---------- drop every older function signature ----------
drop function if exists public.enter_quiz(text, text);
drop function if exists public.create_quiz(text, text, text, integer, jsonb);
drop function if exists public.submit_quiz_attempt(uuid, text, integer, integer, timestamptz);
drop function if exists public.submit_quiz_attempt(uuid, text, jsonb, timestamptz);
drop function if exists public.get_quiz_results(uuid, text);
drop function if exists public.get_results_summary(jsonb);
drop function if exists public.delete_quiz(uuid, text);
drop function if exists public.quiz_hash(text, text);

-- ---------- limits (edit the numbers here) ----------
-- NOTE: a whole classroom often shares ONE public IP, so per-IP numbers are deliberately generous.
create or replace function private.cfg(k text) returns integer
language sql immutable set search_path = ''
as $$
  select case k
    when 'max_quizzes'            then 500   -- total quizzes stored (storage guard for the free 500MB DB)
    when 'max_attempts_per_quiz'  then 500
    when 'create_per_ip_hour'     then 5
    when 'create_global_hour'     then 60
    when 'enter_fail_per_ip_10m'  then 30    -- wrong code/password attempts
    when 'enter_fail_per_code_10m' then 60   -- ...against one specific quiz code (any IP)
    when 'submit_per_ip_10m'      then 300
    when 'results_per_ip_10m'     then 120
    when 'retention_days'         then 180   -- quizzes (and their attempts) older than this are deleted
  end
$$;

-- ---------- helpers (not reachable from the API) ----------
create or replace function private.quiz_hash(p_salt text, p_secret text)
returns text language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p_salt, '') || ':' || coalesce(p_secret, ''), 'UTF8')), 'hex') $$;

-- Client IP as documented by Supabase: first entry of x-forwarded-for.
create or replace function private.client_ip() returns text
language sql stable set search_path = ''
as $$
  select coalesce(
    nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown')
$$;

-- Raises 'rate_limited' when the subject already used up its quota in the window.
create or replace function private.rate_check(p_bucket text, p_subject text, p_limit integer, p_window interval)
returns void language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from private.rate_events e
       where e.bucket = p_bucket and e.subject = p_subject and e.at > now() - p_window) >= p_limit then
    raise exception 'rate_limited';
  end if;
end;
$$;

create or replace function private.rate_record(p_bucket text, p_subject text)
returns void language sql set search_path = ''
as $$ insert into private.rate_events (bucket, subject) values (p_bucket, left(p_subject, 80)) $$;

-- Cheap housekeeping, run on ~5% of writes: expire old quizzes and old rate-limit rows.
create or replace function private.maintenance() returns void
language plpgsql set search_path = ''
as $$
begin
  if random() < 0.05 then
    delete from private.rate_events where at < now() - interval '1 day';
    delete from private.quizzes
     where id in (select z.id from private.quizzes z
                   where z.created_at < now() - make_interval(days => private.cfg('retention_days'))
                   limit 100);
  end if;
end;
$$;

-- ---------- teacher: create a quiz ----------
create or replace function public.create_quiz(
  p_title text, p_description text, p_password text, p_duration integer, p_questions jsonb)
returns table (id uuid, access_code text, title text, duration_minutes integer, teacher_key text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ip text := private.client_ip();
  v_code text;
  v_try text;
  v_key text := replace(gen_random_uuid()::text, '-', '');
  v_q jsonb;
  v_n integer;
begin
  if coalesce(trim(p_title), '') = '' or length(p_title) > 120 then raise exception 'invalid title'; end if;
  if length(coalesce(p_description, '')) > 500 then raise exception 'invalid description'; end if;
  if coalesce(trim(p_password), '') = '' or length(p_password) > 100 then raise exception 'invalid password'; end if;
  if p_duration is null or p_duration not between 1 and 240 then raise exception 'invalid duration'; end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) not between 1 and 100
     or length(p_questions::text) > 200000 then
    raise exception 'invalid questions';
  end if;

  for v_q in select * from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(v_q -> 'question') <> 'string' or trim(v_q ->> 'question') = ''
       or length(v_q ->> 'question') > 1000
       or jsonb_typeof(v_q -> 'answers') <> 'array'
       or jsonb_array_length(v_q -> 'answers') not between 2 and 4
       or jsonb_typeof(v_q -> 'correct') <> 'number' then
      raise exception 'invalid question';
    end if;
    v_n := (v_q ->> 'correct')::integer;
    if v_n < 0 or v_n >= jsonb_array_length(v_q -> 'answers') then raise exception 'invalid correct answer'; end if;
  end loop;

  perform private.rate_check('create_ip', v_ip, private.cfg('create_per_ip_hour'), interval '1 hour');
  perform private.rate_check('create_all', 'all', private.cfg('create_global_hour'), interval '1 hour');
  perform private.maintenance();
  if (select count(*) from private.quizzes) >= private.cfg('max_quizzes') then
    raise exception 'capacity_reached';
  end if;
  perform private.rate_record('create_ip', v_ip);
  perform private.rate_record('create_all', 'all');

  -- bounded: at most 20 tries, never an endless loop
  for i in 1..20 loop
    v_try := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    if not exists (select 1 from private.quizzes z where z.access_code = v_try) then
      v_code := v_try;
      exit;
    end if;
  end loop;
  if v_code is null then raise exception 'try_again'; end if;

  return query
    insert into private.quizzes as z (title, description, access_code, password_hash, teacher_key_hash, duration_minutes, questions)
    values (trim(p_title), coalesce(p_description, ''), v_code, private.quiz_hash(v_code, p_password),
            private.quiz_hash('teacher', v_key), p_duration, p_questions)
    returning z.id, z.access_code, z.title, z.duration_minutes, v_key;
end;
$$;

-- ---------- student: enter a quiz (correct answers are stripped out) ----------
-- Wrong attempts are recorded (and the call still succeeds with 0 rows, so the record is kept);
-- once the quota is used up the function raises 'rate_limited' before even checking the password.
create or replace function public.enter_quiz(p_code text, p_password text)
returns table (id uuid, title text, description text, duration_minutes integer, questions jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ip text := private.client_ip();
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if length(v_code) > 12 or length(coalesce(p_password, '')) > 100 then return; end if;
  perform private.rate_check('enter_fail_ip', v_ip, private.cfg('enter_fail_per_ip_10m'), interval '10 minutes');
  perform private.rate_check('enter_fail_code', v_code, private.cfg('enter_fail_per_code_10m'), interval '10 minutes');

  return query
    select q.id, q.title, q.description, q.duration_minutes,
           (select coalesce(jsonb_agg(t.elem - 'correct' order by t.ord), '[]'::jsonb)
              from jsonb_array_elements(q.questions) with ordinality as t(elem, ord))
      from private.quizzes q
     where q.access_code = v_code
       and q.password_hash = private.quiz_hash(q.access_code, p_password);

  if not found then
    perform private.rate_record('enter_fail_ip', v_ip);
    perform private.rate_record('enter_fail_code', v_code);
  end if;
end;
$$;

-- ---------- student: submit answers (server grades) ----------
-- p_answers is a JSON array of chosen option indexes, e.g. [1, 0, null, 2]  (null = unanswered)
-- Re-sending the same attempt (same quiz + name + started_at) returns the first result instead of a duplicate.
create or replace function public.submit_quiz_attempt(
  p_quiz_id uuid, p_student_name text, p_answers jsonb, p_started_at timestamptz)
returns table (score integer, total integer)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ip text := private.client_ip();
  v_name text := trim(coalesce(p_student_name, ''));
  v_questions jsonb;
  v_total integer;
  v_score integer;
begin
  if v_name = '' or length(v_name) > 80 then raise exception 'invalid name'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'invalid answers'; end if;

  select z.questions into v_questions from private.quizzes z where z.id = p_quiz_id;
  if v_questions is null then raise exception 'quiz not found'; end if;
  v_total := jsonb_array_length(v_questions);
  if jsonb_array_length(p_answers) > v_total then raise exception 'invalid answers'; end if;

  if p_started_at is not null then
    return query
      select a.score, a.total from private.quiz_attempts a
       where a.quiz_id = p_quiz_id and lower(a.student_name) = lower(v_name) and a.started_at = p_started_at
       limit 1;
    if found then return; end if;
  end if;

  perform private.rate_check('submit_ip', v_ip, private.cfg('submit_per_ip_10m'), interval '10 minutes');
  if (select count(*) from private.quiz_attempts a where a.quiz_id = p_quiz_id) >= private.cfg('max_attempts_per_quiz') then
    raise exception 'quiz_full';
  end if;
  perform private.rate_record('submit_ip', v_ip);
  perform private.maintenance();

  select count(*) into v_score
    from jsonb_array_elements(v_questions) with ordinality as t(q, ord)
   where (p_answers -> (t.ord - 1)::integer) = (t.q -> 'correct');

  insert into private.quiz_attempts (quiz_id, student_name, score, total, answers, started_at)
  values (p_quiz_id, v_name, v_score, v_total, p_answers, coalesce(p_started_at, now()));

  return query select v_score, v_total;
end;
$$;

-- ---------- teacher: results / summary / delete (all need the teacher key) ----------
create or replace function public.get_quiz_results(p_quiz_id uuid, p_teacher_key text)
returns table (student_name text, score integer, total integer, submitted_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare v_ip text := private.client_ip();
begin
  perform private.rate_check('results_ip', v_ip, private.cfg('results_per_ip_10m'), interval '10 minutes');
  perform private.rate_record('results_ip', v_ip);
  return query
    select a.student_name, a.score, a.total, a.submitted_at
      from private.quiz_attempts a
      join private.quizzes q on q.id = a.quiz_id
     where q.id = p_quiz_id and q.teacher_key_hash = private.quiz_hash('teacher', p_teacher_key)
     order by a.submitted_at desc
     limit 500;
end;
$$;

-- One call for the whole dashboard: p_items = [{"id": "<quiz uuid>", "key": "<teacher key>"}, ...] (max 50)
create or replace function public.get_results_summary(p_items jsonb)
returns table (quiz_id uuid, attempts integer, avg_percent integer)
language plpgsql security definer set search_path = ''
as $$
declare v_ip text := private.client_ip();
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then raise exception 'invalid items'; end if;
  perform private.rate_check('results_ip', v_ip, private.cfg('results_per_ip_10m'), interval '10 minutes');
  perform private.rate_record('results_ip', v_ip);
  return query
    select q.id,
           count(a.id)::integer,
           coalesce(round(avg(case when a.total > 0 then a.score * 100.0 / a.total end)), 0)::integer
      from jsonb_to_recordset(p_items) as x(id uuid, key text)
      join private.quizzes q on q.id = x.id and q.teacher_key_hash = private.quiz_hash('teacher', x.key)
      left join private.quiz_attempts a on a.quiz_id = q.id
     group by q.id;
end;
$$;

create or replace function public.delete_quiz(p_quiz_id uuid, p_teacher_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_ip text := private.client_ip();
  v_count integer;
begin
  perform private.rate_check('results_ip', v_ip, private.cfg('results_per_ip_10m'), interval '10 minutes');
  perform private.rate_record('results_ip', v_ip);
  delete from private.quizzes q
   where q.id = p_quiz_id and q.teacher_key_hash = private.quiz_hash('teacher', p_teacher_key);
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- ---------- permissions: only these 6 functions are callable from the browser ----------
revoke all on function public.create_quiz(text, text, text, integer, jsonb) from public;
revoke all on function public.enter_quiz(text, text) from public;
revoke all on function public.submit_quiz_attempt(uuid, text, jsonb, timestamptz) from public;
revoke all on function public.get_quiz_results(uuid, text) from public;
revoke all on function public.get_results_summary(jsonb) from public;
revoke all on function public.delete_quiz(uuid, text) from public;

grant execute on function public.create_quiz(text, text, text, integer, jsonb) to anon, authenticated;
grant execute on function public.enter_quiz(text, text) to anon, authenticated;
grant execute on function public.submit_quiz_attempt(uuid, text, jsonb, timestamptz) to anon, authenticated;
grant execute on function public.get_quiz_results(uuid, text) to anon, authenticated;
grant execute on function public.get_results_summary(jsonb) to anon, authenticated;
grant execute on function public.delete_quiz(uuid, text) to anon, authenticated;
