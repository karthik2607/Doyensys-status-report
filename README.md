# Doyensys Portal

A customer support portal for Doyensys managed-services customers (e.g. Petmate). Customers and Doyensys support staff log in to see and work on **incidents, service requests and changes**, follow **projects**, receive **notifications**, and read **weekly status reports**. Support staff can also generate the weekly status report from an Excel template.


---

## 1. How it fits together

```
 Browser
   │
   ├── http://<server>:5000   ── frontend: one static HTML file (python http.server)
   │
   └── http://<server>:4000/api ── backend API (Node.js + Fastify, systemd: doyensys-api)
                                     │
                                     ├── PostgreSQL 16 (database "doyensys", Prisma ORM, row-level security)
                                     ├── /opt/doyensys/uploads   (attachments, uploaded status reports)
                                     ├── /opt/doyensys/logos     (customer logos, served at /api/logos/…)
                                     ├── SMTP  (outgoing email notifications)
                                     └── IMAP  (optional: turns emails into incidents)
```

| Part | Technology |
|---|---|
| Frontend | A single HTML/JS file: `frontend/doyensys-portal-live.html`. No build step. |
| Backend | Node.js (TypeScript), Fastify 4, Prisma 5, JWT auth, ExcelJS, Nodemailer |
| Database | PostgreSQL 16, with tenant isolation through row-level security (`backend/prisma/rls-policies.sql`) |
| Hosting | One Ubuntu 24.04 VM on OCI |
| Deploys | GitHub Actions → SSH → `deploy/deploy.sh` on the server |

### Main features
- **Login and roles.** `CUSTOMER_*` roles see only their own organisation's data; `SUPPORT_*` roles (Doyensys) see every organisation. Internal notes are hidden from customers.
- **Tickets.** Incidents, requests and changes (with a change-approval workflow), plus attachments.
- **Dashboard and trends.** Ticket statistics and charts.
- **Projects.** Project plans, with Excel import and export.
- **Notifications.** In-app and by email.
- **Branding.** Each customer organisation has its own logo and branding.
- **Weekly status reports.** Upload a ready-made HTML report, or generate one from the Excel template (see section 7).
- **Email-to-ticket (optional).** Polls a mailbox and opens an incident for each email from a known customer.

---

## 2. Repository layout

```
.
├── .github/workflows/deploy.yml   CI: build check, then deploy over SSH
├── deploy/deploy.sh               Runs ON THE SERVER on every deploy
├── frontend/
│   └── doyensys-portal-live.html  The whole UI (API address set at the API_BASE line)
└── backend/
    ├── src/
    │   ├── server.ts              Entry point: registers plugins and routes
    │   ├── routes/                One file per area (auth, incidents, weeklyReport, …)
    │   ├── services/              Auth, email sending, email ingestion
    │   ├── lib/                   Prisma client, tenant context, weekly report engine
    │   ├── workflow/              Change-approval workflow
    │   └── middleware/            JWT authentication
    ├── prisma/
    │   ├── schema.prisma          Database schema
    │   ├── migrations/            Migration history (applied automatically on deploy)
    │   └── rls-policies.sql       Row-level security policies
    ├── scripts/                   Admin CLI scripts (seed, create account, etc.)
    ├── .env.example               Every setting the backend reads
    └── package.json
```

`backend/README.md` is the original Phase-1 note and is out of date. This file is the current reference.

---

## 3. Local development

**You need:** Node.js 20 or newer (the server runs 26), PostgreSQL 16, and Git.

```bash
git clone https://github.com/karthik2607/Doyensys-status-report.git
cd Doyensys-status-report/backend

cp .env.example .env            # then edit: DATABASE_URL, JWT_SECRET, SMTP_*, CORS_ORIGIN, …
npm ci
npx prisma generate
npx prisma migrate deploy       # create tables from the migration history
npm run rls:apply               # apply row-level security (uses psql + DATABASE_URL)
npm run seed                    # optional: demo organisations and users

npm run dev                     # API on http://localhost:4000 (restarts when files change)
```

**Frontend:** open `frontend/doyensys-portal-live.html` in a browser. It calls the API at the address in its `API_BASE` line. Point that at `http://localhost:4000/api` for local work, but **don't commit that change**.

**Check the API is up:** `curl http://localhost:4000/health` should return `{"ok":true}`.

### Useful backend scripts (`npm run <name>`)
| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Run with auto-reload / compile to `dist/` / run the compiled build |
| `seed` | Create demo organisations and users. **Change the seed password in `scripts/seed.ts` before any real use.** |
| `create-account`, `list-users`, `remove-user`, `set-password` | User administration |
| `set-org-branding`, `setup-customer` | Customer organisation setup |
| `test-email` | Send a test email using the SMTP settings |
| `rls:apply` | Re-apply the row-level security policies |

### Changing the database schema
1. Edit `backend/prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name <short_description>` locally. This creates a new folder in `prisma/migrations/`.
3. Commit the schema change **and** the new migration folder. The deploy applies it with `prisma migrate deploy`.

Never change the server database by hand. It will no longer match the migration history.

---

## 4. Configuration (`backend/.env`)

`.env` is **never committed**. Each machine has its own copy. `backend/.env.example` lists every setting:

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | API port (4000) |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Login tokens. Generate the secret with `openssl rand -hex 32`. |
| `BCRYPT_ROUNDS` | Password hashing cost (10–12) |
| `EMAIL_NOTIFICATIONS_ENABLED`, `SMTP_*` | Outgoing email |
| `EMAIL_INGESTION_ENABLED`, `IMAP_*` | Email-to-ticket (optional) |
| `ATTACHMENTS_DIR`, `LOGOS_DIR`, `ATTACHMENT_MAX_SIZE_MB` | File storage |
| `PORTAL_URL` | Address of the portal, used for links in emails |
| `CORS_ORIGIN` | Browser origin allowed to call the API |

If a value contains special characters, wrap it in double quotes. Don't `source` this file in bash; Node and Prisma read it themselves.

---

## 5. Server setup (from scratch)

These are the steps used for the current server. To move to a new VM, repeat them and then update the `SERVER_HOST` secret (section 6).

**Sizing:** the app is light. On today's data it uses about 110 MB of RAM for the API and about 10 MB of database. **1 OCPU with 2–4 GB RAM** is plenty. With only 1 GB, add swap, because the build during each deploy briefly needs several hundred MB. Run it on its own VM, **not** on a bastion or jump host.

### 5.1 Packages and user (as an admin user)
```bash
sudo apt update && sudo apt install -y git postgresql curl
# Node.js 20 or newer, e.g. from NodeSource or the distro's nodejs package
sudo adduser --disabled-password --gecos "" doyensys
sudo mkdir -p /opt/doyensys/{uploads,logos,public} && sudo chown -R doyensys:doyensys /opt/doyensys
```

### 5.2 Database
```bash
sudo -u postgres psql -c "CREATE ROLE doyensys_app LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE doyensys OWNER doyensys_app;"
```

### 5.3 Code and configuration (as `doyensys`)
1. Give the server read access to the GitHub repo:
   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy
   printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' > ~/.ssh/config
   ```
   Add `~/.ssh/github_deploy.pub` in GitHub under **repo → Settings → Deploy keys** (read-only).
2. Clone and configure:
   ```bash
   git clone git@github.com:karthik2607/Doyensys-status-report.git /opt/doyensys/app
   cd /opt/doyensys/app/backend
   cp .env.example .env && chmod 600 .env          # fill in real values
   npm ci && npx prisma generate && npx prisma migrate deploy && npm run rls:apply && npm run build
   ```

### 5.4 Backend service: `/etc/systemd/system/doyensys-api.service`
```ini
[Unit]
Description=Doyensys ITSM Portal API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=doyensys
Group=doyensys
WorkingDirectory=/opt/doyensys/app/backend
EnvironmentFile=/opt/doyensys/app/backend/.env
ExecStart=/usr/bin/node dist/src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now doyensys-api
curl http://localhost:4000/health
```

### 5.5 Frontend
The deploy copies `frontend/doyensys-portal-live.html` to `/opt/doyensys/public/index.html`, and it is served on port 5000.

**Known gap:** on the current server, `python3 -m http.server 5000` was started by hand and is **not** a service, so it won't come back after a reboot. To fix that, create `/etc/systemd/system/doyensys-web.service`:
```ini
[Unit]
Description=Doyensys portal frontend (static)
After=network.target

[Service]
User=doyensys
WorkingDirectory=/opt/doyensys/public
ExecStart=/usr/bin/python3 -m http.server 5000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
Stop the manual process, then run `sudo systemctl enable --now doyensys-web`.

### 5.6 Firewall
Open TCP **4000** (API) and **5000** (frontend) in the OCI security list and in the VM's iptables. SSH (22) must be reachable from GitHub Actions for deploys.

### 5.7 Deploy permissions
Let the deploy restart the service without a full sudo password:
```bash
echo 'doyensys ALL=(root) NOPASSWD: /usr/bin/systemctl restart doyensys-api, /usr/bin/systemctl status doyensys-api' \
  | sudo tee /etc/sudoers.d/doyensys-deploy && sudo chmod 440 /etc/sudoers.d/doyensys-deploy && sudo visudo -c
```
Create the key GitHub Actions logs in with (as `doyensys`):
```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/gh_actions
cat ~/.ssh/gh_actions.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```
The private key `~/.ssh/gh_actions` goes into the `SERVER_SSH_KEY` secret (section 6).

---

## 6. Deploying (CI/CD)

**Every push to `main` deploys automatically.**

```
git push ─▶ GitHub Actions
             1. build:  npm ci → prisma generate → npm run build   (fails = nothing deployed)
             2. deploy: SSH to the server as doyensys → bash /opt/doyensys/app/deploy/deploy.sh
                          ├─ git fetch + reset to origin/main
                          ├─ npm ci, prisma generate, prisma migrate deploy, npm run build
                          ├─ sudo systemctl restart doyensys-api
                          ├─ copy frontend HTML to /opt/doyensys/public/index.html
                          └─ health check on :4000/health (fails the run if the API doesn't come up)
```

Repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `SERVER_HOST` | Server IP address |
| `SERVER_USER` | `doyensys` |
| `SERVER_SSH_KEY` | Private key from section 5.7 |

**Day to day:**
```bash
git add -A
git commit -m "describe the change"
git push            # then watch the repo's Actions tab
```
You can also re-run a deploy from the Actions tab (**Deploy to server → Run workflow**), or on the server with `sudo -iu doyensys bash /opt/doyensys/app/deploy/deploy.sh`.

**Rollback:** revert the bad commit with `git revert <sha>` and push. The pipeline then deploys the previous state.

---

## 7. Weekly status report generator

Support staff download an Excel template from the portal, fill it in, upload it with the week's dates, check the preview, and publish. The code is in `backend/src/lib/weeklyReport*.ts`.

| File | Role |
|---|---|
| `weeklyReportTemplate.ts` | Builds the downloadable Excel template |
| `weeklyReportParser.ts` | Reads a filled-in template |
| `weeklyReportModel.ts` | Shared types, reporting-week and month helpers |
| `weeklyReportHtml.ts` | Renders the report (charts and tables) into the HTML shell |
| `../assets/weeklyReportShell.ts` | The report's HTML/CSS design |

Rules that matter:
- **A reporting week runs Wednesday to Tuesday.** Chart weeks are labelled by their end date (the Tuesday).
- **Ticket trends.** Received vs Closed and Carry Forward are line charts covering the **last 8 weeks**. Carry-forward is always typed, never calculated.
- **Project hours.**
  - The report shows the **last 3 months**, as a table by month and grouped bars by track.
  - Aug–Oct 2026 are pre-filled monthly rows in the template.
  - From November 2026 there is one row per track per week, with Week Start and Week End filled in. Each month is the running total of its weeks, and a week counts toward the month its end date falls in.
  - The "Projects – Weekly Summary" shows only the reported week.
- **An empty Excel cell is never zero.** It stays blank in tables, draws no point or bar, and is left out of totals. Every template sheet says so.
- **Old reports don't change.** Each generated report is saved as a fixed HTML file, so code changes only affect reports generated afterwards.

---

## 8. Operations cheat-sheet (on the server)

```bash
systemctl status doyensys-api            # is the API running?
journalctl -u doyensys-api -n 100 -f     # API logs
sudo systemctl restart doyensys-api      # restart the API
curl http://localhost:4000/health        # health check
sudo -u postgres psql doyensys           # database shell
git -C /opt/doyensys/app log -1          # which commit is deployed
```

**Backups:** these aren't automated yet. A simple daily option:
`pg_dump -Fc doyensys > /backup/doyensys-$(date +%F).dump`, plus a copy of `/opt/doyensys/uploads` and `/opt/doyensys/logos`.

## 9. Security notes
- **Secrets:** never commit `.env`, keys or passwords. `.gitignore` already excludes `.env`.
- **HTTP only:** the portal runs over plain HTTP during testing. Before real customer use, add a domain and TLS (e.g. Nginx or Caddy as a reverse proxy) and close ports 4000/5000 to the public.
- **Demo password:** change the seed password before loading any real data.
