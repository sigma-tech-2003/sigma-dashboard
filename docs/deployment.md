# Deploying the demo: Vercel + Render + Neon (all free tiers)

```
Browser -> Vercel (React app, https://<project>.vercel.app)
              | rewrite /api/*   (vercel.json, decision D36: same origin, so the SameSite=Strict refresh cookie works)
              v
           Render (Express API, https://sigma-hrm-api.onrender.com)   -> Neon (PostgreSQL)
```

| Piece | Where | Config in the repo |
|---|---|---|
| Frontend | Vercel | `vercel.json` (the `/api` rewrite; its destination must be the Render host) |
| API | Render, free web service, Singapore | `render.yaml` |
| Database | Neon, free plan, Singapore | none: its connection string is `DATABASE_URL` |

## Free-tier behaviour to expect

- Render spins the API down after 15 idle minutes; the next request waits about a minute while it wakes. The first
  page load after a quiet spell can fail through the Vercel proxy: reload once. An uptime monitor that calls
  `/api/v1/health` every 10 minutes keeps it awake (one always-on service fits in Render's 750 free hours a month).
- Neon suspends compute after 5 idle minutes and wakes on the next query, within a few seconds. `src/db/pool.js`
  handles the dropped connections.
- Render's own free Postgres expires after 30 days. Do not use it.
- There is no login throttling in the API. Anything public needs strong passwords.

## One-time setup

1. **Neon**: create a project (region Singapore), copy the connection string, put it in `backend/.env` as
   `DATABASE_URL=` with `DATABASE_SSL=true`. `backend/.env` is gitignored.
2. **Migrate and seed** (from `backend/`): `npm run db:migrate`, then
   `npm run db:seed-demo -- --confirm-database=<database name in the Neon string>`.
   The seed refuses a database that already has a company or users, and it writes the five logins to
   `backend/exports/demo-credentials.txt` (gitignored).
3. **Render**: New > Blueprint > pick this repo and the `migration/postgres` branch. Paste Neon's string as
   `DATABASE_URL` when asked. `AUTH_TOKEN_SECRET` is generated for you. Confirm the service URL is
   `https://sigma-hrm-api.onrender.com`; if Render gave it another name, change the destination in `vercel.json`.
4. **Vercel**: the repo is already linked; the push to `migration/postgres` builds a preview deployment. Open it and
   sign in with one of the demo accounts.

Seeding runs from your machine, not from Render, because `seed-demo.js` (like the other write scripts) refuses
`NODE_ENV=production`.
