# Quiz App — اختبر معلوماتك

Arabic-first quiz platform (PWA). Teachers create a quiz (manually or by importing a PDF), share a code + password,
students take it from any device, and the **server grades** the attempt.

## Features
- Teacher flow: create quiz, import questions from PDF (`1.` question, `A)` options, `Answer: B`), results dashboard
- Student flow: join with code + password, countdown timer, instant score
- Installable PWA, responsive, dark mode
- Works without Supabase too (falls back to `localStorage`, single browser only)

## Run locally
```bash
npm install
cp .env.example .env     # fill in your Supabase URL + anon key
npm run dev
```

## Supabase setup (free plan)
1. Create a project at supabase.com
2. SQL Editor → paste and run `supabase/schema.sql` (safe to re-run; it also upgrades older versions and keeps their data)
3. Project Settings → API → copy the **Project URL** and the **anon public** key into `.env`
   (never put the `service_role` key in the frontend)
4. The app does not use Supabase Auth, so turn off new user sign-ups in the Authentication settings.

## Deploy
Build command `npm run build`, output `dist`, and add `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` as environment variables.
- **Cloudflare Pages (recommended for a free, flood-proof front end):** static assets are not bandwidth-metered on the free plan.
- **Vercel Hobby / Netlify Free:** also free, but both have monthly usage limits; when exceeded, the project is paused
  rather than billed, and a traffic flood (including bots) can use that allowance up.

## Who can read the data
- Tables live in the `private` schema. Supabase exposes only `public` through its API, and the browser's roles (`anon`,
  `authenticated`) have no access to `private` at all. Row Level Security is also on (no policies) as a second lock.
- The browser can only call 6 functions: `create_quiz`, `enter_quiz`, `submit_quiz_attempt`, `get_quiz_results`,
  `get_results_summary`, `delete_quiz`.
- Quiz passwords and the teacher key are stored hashed. Students never receive the correct answers; grading is server-side.
- Results are readable only with the quiz's secret teacher key (kept in the teacher's browser).

## Abuse and traffic limits
All numbers live in one place: `private.cfg()` in `supabase/schema.sql`.

| Protection | Default |
|---|---|
| Quizzes created per IP / globally | 5 / hour, 60 / hour |
| Wrong code or password attempts | 30 per IP and 60 per quiz code, per 10 minutes (then even the right password is refused for a while) |
| Submissions per IP | 300 per 10 minutes (a whole class often shares one IP) |
| Results / delete requests per IP | 120 per 10 minutes |
| Total quizzes stored | 500 |
| Attempts per quiz | 500 |
| Quiz size | up to 100 questions, 200 KB |
| Retention | quizzes older than 180 days are deleted automatically |

Notes: per-IP limits use the `x-forwarded-for` header as Supabase documents; they are best-effort, which is why the global
limits and hard caps exist as a backstop. Network-level flood protection (L3/L4) is provided by the hosting platforms, not by this code.
Supabase also stops any anonymous API query that runs longer than 3 seconds (its default `statement_timeout` for `anon`).

## Costs: nothing in this project can start charging you
- The code calls no paid API (PDF text extraction runs in the browser).
- Keep the Supabase project on the **Free** plan: per Supabase's docs you are not charged on Free; going over quota leads to
  a notice, a grace period and then restrictions. If you ever upgrade to Pro, keep the **Spend Cap on** (the default; note it does not cover compute).
- Don't enable paid add-ons (custom domain, extra compute, backups) and don't upgrade the hosting plan.

## Nothing runs by itself
No cron jobs, Edge Functions, Realtime subscriptions, polling or background workers. Supabase Auth's token-refresh timers are disabled
in `src/lib/supabase.js`, every request times out after 15 s, and the code generator is a bounded loop. The only recurring
work is cleanup of old rows, which piggybacks on normal requests. A free Supabase project may pause itself after about a week
without activity; open the dashboard to resume it.

## Known limitations
- No teacher accounts: results are tied to a secret key kept in the teacher's browser (clearing site data loses access)
- The exam time limit is enforced in the browser only
- A student can retake a quiz; identical re-sends of one attempt are de-duplicated, but separate attempts are not blocked
