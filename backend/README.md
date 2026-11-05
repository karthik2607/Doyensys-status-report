# Doyensys Portal Backend — Phase 1: Foundation + Auth

This is the first implementation slice, built in the same order as the HTML
prototype (Login screen was first in the UI, so it's first here). It covers:

- Full Prisma schema for the entire application (all 32 features from the
  feature inventory — later phases build the routes for the rest; the tables
  already exist so nothing needs re-migrating later)
- Row-Level Security policies (`prisma/rls-policies.sql`) implementing:
  org-level tenant isolation for CUSTOMER_* roles, cross-org visibility for
  SUPPORT_* roles, and the internal/customer note-visibility split
- Password + JWT authentication (`POST /api/auth/login`, `GET /api/auth/me`)
- `withTenantContext()` — the single choke point every future route uses to
  set RLS session variables and enforce tenant scoping at the query layer
- Seed script with real bcrypt-hashed passwords for the same people who
  appear in the prototype's seed data (John Smith, Dana Whitfield as
  customers; Ravi Kumar, Sarah Chen as Doyensys support)

## What's NOT in this phase yet

Dashboard, Incidents/Requests/Changes, Status Reports, Projects, and
Notifications routes — these come next, in that order, matching the HTML.
The Prisma schema already has every table they'll need.

## Install on your server

You already have `/opt/doyensys` set up with a working `.env` and DB
connection. Drop these files into that folder (overwriting the placeholder
`prisma/schema.prisma` if one exists), then:

```bash
cd /opt/doyensys
npm ci
npx prisma generate
npx prisma migrate dev --name init      # first migration, creates all tables
npm run rls:apply                       # applies prisma/rls-policies.sql
npm run seed                            # creates the two orgs + four users
```

Add these two lines to your `.env` if they're not already there:

```ini
JWT_SECRET="<run: openssl rand -hex 32>"
JWT_EXPIRES_IN="8h"
```

## Test the auth flow

```bash
npm run dev
```

In another terminal:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john.smith@abccorp.com","password":"Doyensys@2026"}'
```

Expect a `{ token, user }` response. Then:

```bash
TOKEN="paste-the-token-here"
curl http://localhost:4000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

Same test with `ravi.kumar@doyensys.com` / `Doyensys@2026` should return a
`SUPPORT_AGENT` role instead of `CUSTOMER_ADMIN`.

**Change the seed password** (`scripts/seed.ts` → `SEED_PASSWORD`) before
using this anywhere near production data — it's a shared demo password for
initial testing only.

## Next phase

Home/Dashboard endpoints (stat cards, action center, activity digest,
company updates, project pulse, upcoming initiatives) — features #4 through
#12 in the feature inventory doc.
