# Harbour

Harbour is two things working together:

1. **The app** — `index.html` / `styles.css` / `app.js`, the interface (Week / Today / Reflect, drag-and-drop, goal types, work shifts).
2. **A small backend** — a handful of files under `netlify/functions/`, plus storage, that let the app keep your data in the cloud instead of just one browser. That's what makes cross-device sync and a daily automatic email possible — a scheduled job can't read your phone's local storage at 7am, it needs somewhere of its own to look.

This is a real step up in complexity from a plain static site. Take the setup slowly — every step below is a dashboard click or a short command, not real coding, but there are quite a few of them the first time.

## What you need before you start
- A **Netlify account** (free) — netlify.com
- A **GitHub account** (free) — github.com — Netlify deploys from a repo; this is also what makes Scheduled Functions work (drag-and-drop deploys don't run functions)
- A **Resend account** (free tier is plenty for one person) — resend.com — the service that actually sends the email

## Step 1 — Push this folder to GitHub
1. Create a new (empty) repository on GitHub, e.g. `harbour`
2. From inside this `harbour` folder on your computer, run:
   ```
   git init
   git add .
   git commit -m "Harbour"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/harbour.git
   git push -u origin main
   ```
   (No `git` installed? GitHub Desktop does the same thing with buttons instead of commands — github.com/apps/desktop.)

## Step 2 — Import the project into Netlify
1. On app.netlify.com, **Add new site → Import an existing project**
2. Connect GitHub and pick the `harbour` repo
3. Build settings: leave the **publish directory** as `.` (repo root) — `netlify.toml` in this folder already tells Netlify where the functions live, so you shouldn't need to change anything here
4. Click **Deploy site**. It'll go live even before the next steps — it just won't have email working until you add the Resend details.

Netlify Blobs (the storage) needs **no setup at all** — it's automatically available to your functions the moment the site is deployed. That's one less step than most cloud databases.

## Step 3 — Set up Resend (the email sender)
1. Sign up at resend.com, then go to **API Keys → Create API Key**. Copy it.
2. For the "from" address: Resend lets you send from `onboarding@resend.dev` with no setup, which is fine to start with. If you want it to arrive from your own address/domain later, Resend's dashboard walks you through verifying a domain — check their current docs, since this process does change from time to time.

## Step 4 — Set your environment variables
In your Netlify site: **Site configuration → Environment variables → Add a variable**. Add these:

| Name | Value |
|---|---|
| `HARBOUR_SECRET` | Any passphrase you make up — this is what unlocks the app itself (see Step 5) |
| `RESEND_API_KEY` | The API key from Step 3 |
| `HARBOUR_EMAIL_TO` | The email address you want the daily brief sent to |
| `HARBOUR_EMAIL_FROM` | `onboarding@resend.dev` (or your verified sender) |

After adding these, trigger a new deploy so the functions pick them up (**Deploys → Trigger deploy → Deploy site**).

## Step 5 — Open the app and unlock it
Visit your Netlify URL, on your phone or your laptop — same URL either way, that's the whole point now. The first time on *each device*, it'll ask for an **access code** — type in whatever you set as `HARBOUR_SECRET`. It's remembered on that device afterwards, but because the data itself now lives on Netlify rather than in one browser, anything you add on your phone shows up on your laptop and vice versa.

## Step 6 — Check the daily email works
The function is scheduled for **6am UTC**, which is 7am UK time in summer (BST) and 6am in winter (GMT) — cron schedules run in UTC and don't shift with the clocks. If that bothers you once the clocks change, edit the cron expression at the bottom of `netlify/functions/cron-email.js` (`'0 6 * * *'`), push, and it redeploys automatically.

It only sends once your app has at least one goal/task saved *for the current week* — with nothing planned, it skips rather than emailing a blank page. To test without waiting for the schedule: **Netlify dashboard → your site → Functions → cron-email → Run now**.

## How the data model works (unchanged)
- **Goals** — each has a `type`: completion, time, quantity, repetitions, checklist, or simple. Progress is calculated from that type, never from calendar time.
- **Tasks** — standalone or linked to a goal via `goalId`.
- **Calendar blocks** — link to a goal or task and give it a specific day + time. Scheduling something never changes its target type.
- **Shifts** — your work hours, shown as blocked-out time and editable by clicking them.
- Goals/tasks can be **unscheduled**, **assigned to a day** (no fixed time), or **time-blocked** (exact hour).

## What changed under the hood
- Data lives in Netlify Blobs, one entry per week, read/written through `/.netlify/functions/week`. The browser keeps a local copy in `localStorage` (`harbour_cache_v3`) purely so the app has something to show instantly and still works (read-only) if you lose signal — Blobs is the real copy, shared across every device that unlocks with the same access code.
- If you used an earlier local-only version of Harbour in this same browser, that old data is **not** automatically copied into the cloud — there was never a server for it to go to. It's still sitting in that browser's localStorage under the old keys if you want to copy anything across by hand.
- A small badge near "Plan my week" shows **Synced** or **Offline — showing last saved copy**.

## If something breaks
- **App won't load past the access code screen** — double check `HARBOUR_SECRET` matches exactly, and that you triggered a new deploy after setting it.
- **"Offline" badge stuck on** — open your browser's dev tools (F12 or right-click → Inspect) → Network tab, reload, and check whether the calls to `/.netlify/functions/week` are failing — the response will usually say why.
- **No email arriving** — check Netlify → your site → Functions → `cron-email` → logs, for errors; check spam folder; confirm the Resend API key is correct.
- **Want a clean slate** — clear `harbour_cache_v3` from your browser's localStorage to reset the local copy (the cloud copy in Blobs isn't affected by this — you'd need to delete week data via the functions themselves for that).
