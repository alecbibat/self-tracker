# Self Tracker

A personal self-tracker and portfolio web app, built to run on Heroku.

It has two halves:

- **A public site** — an editable full-screen landing page (image/video/gradient background, title, subtitle, and links to your resume, skills, and projects), a **projects** page of clickable cards, and a **photos** project shown as an Instagram-style reel.
- **A private section** (one password, just for you) — a **habit tracker**, a **calorie / macro / weight tracker**, and a **site admin** area to edit the landing page, manage projects, and upload photos.

---

## Features

### Habit tracker (`/app/habits`)
- Add and remove habits ("calendars") from the page.
- Two habit types: **yes/no** ("did I do X?") and **quantity** ("how much of X did I do?", with a unit and optional daily target).
- Each habit is a month calendar you can page through; click a day to toggle it or enter a value.
- Current-streak and monthly-completion stats per habit.

### Calorie / macro / weight tracker (`/app/nutrition`)
- Set daily goals for calories, protein, carbs, fat, and a weight goal.
- Log meals with individual macros; **save meals to a library** so you can search and quick-select them later.
- Log daily weight.
- Trends with **Week / Month / 3-Month** views: calories vs. goal, macros over time, and weight over time, plus averages.

### Public landing page (`/`)
- Full-screen image, video, or gradient background — all editable from the admin page.
- Large, editable centered title and subtitle.
- Editable link buttons (resume, skills, projects, or anything else).

### Projects (`/projects`)
- Grid of project cards with a cover image, title, and short summary.
- Click a card to open a detail page with the full write-up and an optional external link.

### Photos (`/projects/photos`)
- Instagram-style grid/reel of photos; click any photo to open a lightbox with prev/next navigation.
- When logged in, upload and delete photos right from the page.

### Site admin (`/app/admin`)
- Edit the landing page (background, title, subtitle, links) and site brand/footer.
- Create, edit, reorder, and delete projects (with cover-image uploads).

---

## Tech stack

- **Node.js + Express** (CommonJS, no frontend build step)
- **PostgreSQL** via `pg` — schema auto-migrates on boot (`CREATE TABLE IF NOT EXISTS`)
- **EJS** server-rendered views + plain browser JS
- **Chart.js** (via CDN) for trend charts
- **express-session** with a Postgres session store
- **Uploaded media stored in Postgres** as `bytea` (survives Heroku dyno restarts — no external storage needed)
- **helmet** for security headers / CSP

---

## Local development

Requires Node 22+ and a local PostgreSQL.

```bash
# 1. Install dependencies
npm install

# 2. Create a database (example)
createdb self_tracker

# 3. Configure environment
cp .env.example .env
#   then edit .env:
#   - DATABASE_URL       -> your local Postgres URL
#   - ADMIN_PASSWORD     -> the password for the private section
#   - SESSION_SECRET     -> a long random string
#        node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. Run it (schema is created automatically on first boot)
npm start
#   or, with auto-restart on file changes:
npm run dev
```

Then open <http://localhost:3000>. Log in at `/login` with your `ADMIN_PASSWORD`.

To wipe and recreate all tables locally: `node scripts/reset-db.js --yes`.

---

## Deploying to Heroku

```bash
# From the repo root:
heroku create your-app-name
heroku addons:create heroku-postgresql:essential-0        # provisions DATABASE_URL
heroku config:set ADMIN_PASSWORD='your-strong-password'
heroku config:set SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
heroku config:set NODE_ENV=production

git push heroku HEAD:main        # or your default branch
heroku open
```

Notes:
- The database schema is created automatically the first time the app boots — there is no separate migration step.
- `DATABASE_URL` is provided by the Heroku Postgres add-on; SSL is enabled automatically for non-local hosts.
- `Procfile` runs `node server.js`. `app.json` declares the Postgres add-on and required config vars (useful for the Heroku "Deploy" button and review apps).

### Environment variables

| Variable         | Required | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `DATABASE_URL`   | yes      | Postgres connection string (auto-set by Heroku Postgres) |
| `ADMIN_PASSWORD` | yes      | Password for the private section                         |
| `SESSION_SECRET` | yes      | Secret for signing session cookies                       |
| `NODE_ENV`       | prod     | Set to `production` on Heroku                            |
| `PORT`           | no       | Auto-set by Heroku; defaults to 3000 locally             |
| `DATABASE_SSL`   | no       | Force SSL on/off (`true`/`false`); auto-detected otherwise |

---

## Project structure

```
server.js                 # app entry: middleware, sessions, routes, error handling, boot
src/
  db.js                   # pg pool + full schema + auto-migration + default seed
  settings.js             # get/set site settings (JSONB key/value)
  auth.js                 # single-password auth: requireAuth, passwordMatches
  media.js                # store/serve uploaded media (bytea) in Postgres
  routes/
    auth.js               # /login, /logout
    media.js              # GET /media/:id  (serves image/video bytes)
    public.js             # /, /projects, /projects/:slug
    photos.js             # /api/photos (list/upload/delete)
    habits.js             # /app/habits + /api/habits*
    nutrition.js          # /app/nutrition + /api/nutrition|meals|foods|goals|weights
    admin.js              # /app/admin + /api/admin/* + /api/media (upload)
views/                    # EJS templates (+ partials/ head, navs, footer)
public/
  css/style.css           # design system
  js/common.js            # window.App: api(), toast(), modal(), fmt, ...
scripts/reset-db.js       # drop + re-migrate (local dev helper)
```

---

## Security notes

- The private section is gated by a single password (`ADMIN_PASSWORD`), compared in constant time. This is intended for one owner. For multi-user accounts you'd swap in a `users` table.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- A Content-Security-Policy is set (via helmet) allowing our own assets plus the Chart.js CDN; server data is passed to the client as JSON `<script type="application/json">` blocks, not inline executable scripts.
