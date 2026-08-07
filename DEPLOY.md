# Deploying TEREX Logistics Backend

This backend is a plain Node/Express app with one file-based SQLite database
(`better-sqlite3`). The only thing that matters for deployment is: **the
SQLite file needs to live on storage that survives restarts/redeploys** —
most free PaaS filesystems are wiped on every deploy, so skipping this step
means your data disappears the first time you push an update.

Below: **Railway** (recommended — easiest persistent volume setup) and
**Fly.io** (alternative, also volume-based). Render is possible too but its
free tier doesn't include a persistent disk, so it's not listed as a primary
option — see the note at the bottom if you want to use it anyway.

---

## Option A — Railway (recommended)

### 1. Push this project to GitHub
Railway deploys from a Git repo.
```bash
cd terex-backend
git init
git add .
git commit -m "TEREX Logistics backend"
```
Create a new (empty) repo on GitHub, then:
```bash
git remote add origin https://github.com/<your-username>/terex-backend.git
git branch -M main
git push -u origin main
```

### 2. Create the Railway project
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick `terex-backend`.
2. Railway auto-detects Node.js and runs `npm install` + `npm start` — no config file needed, `package.json` already has the right `start` script.

### 3. Add a persistent volume
1. In the Railway project, open your service → **Settings** → **Volumes** → **New Volume**.
2. Mount path: `/data`
3. This gives the container a `/data` directory that survives redeploys.

### 4. Set environment variables
Service → **Variables** → add:
```
JWT_SECRET=<generate a long random string — do not reuse the .env.example one>
DB_FILE=/data/terex.db
```
(`PORT` is injected automatically by Railway — the app already reads `process.env.PORT`.)

### 5. Seed the database
Railway → your service → **Settings** → note the "Deploy" trigger, or use the Railway CLI to run a one-off command against the deployed environment:
```bash
npm install -g @railway/cli
railway login
railway link          # select your project
railway run npm run seed
```
This runs `src/seed.js` with the deployed `DB_FILE` env var, so it creates
`/data/terex.db` on the volume (not a throwaway local file).

### 6. Get your public URL
Service → **Settings** → **Networking** → **Generate Domain**. You'll get
something like `https://terex-backend-production.up.railway.app`.

### 7. Verify it's alive
```bash
curl https://<your-domain>/api/health
curl -X POST https://<your-domain>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"fariz@terex.local","password":"password123"}'
```

### 8. Point the front-end at it
On the TEREX Logistics login screen, set **Backend API URL** to:
```
https://<your-domain>/api
```

---

## Option B — Fly.io

Fly is a good fit too since it's built around per-app volumes.

```bash
cd terex-backend
curl -L https://fly.io/install.sh | sh     # installs the flyctl CLI
fly auth login
fly launch --no-deploy                      # answer prompts; pick a region close to your users
```

Add a volume and wire it up in the generated `fly.toml`:
```bash
fly volumes create terex_data --size 1      # 1 GB, plenty for SQLite here
```
In `fly.toml`, add:
```toml
[mounts]
  source = "terex_data"
  destination = "/data"

[env]
  DB_FILE = "/data/terex.db"
```
Set the secret and deploy:
```bash
fly secrets set JWT_SECRET="<a long random string>"
fly deploy
```
Seed once after the first deploy:
```bash
fly ssh console -C "npm run seed"
```
Your public URL is `https://<app-name>.fly.dev` — API base is
`https://<app-name>.fly.dev/api`.

---

## If you'd rather use Render

Render's free web services don't include a persistent disk, so `terex.db`
gets wiped on every redeploy (and on every free-tier spin-down/wake cycle).
It'll work fine for a demo you don't restart, but isn't a real option once
people are actually creating data. If you go this route anyway: add Render's
paid **Persistent Disk** add-on, mount it (e.g. at `/data`), and set
`DB_FILE=/data/terex.db` exactly as in the Railway steps above.

---

## Post-deploy checklist

- [ ] `GET /api/health` returns `{"ok":true,...}`
- [ ] Login works for at least one demo account
- [ ] `JWT_SECRET` is a real random value, not the placeholder from `.env.example`
- [ ] Change or remove the demo accounts' `password123` before any real use — the seed script (`src/seed.js`) is the place to edit this
- [ ] Front-end's "Backend API URL" on the login screen points at `https://<your-domain>/api` (must include the `/api` suffix)
- [ ] Photos are stored as base64 in SQLite for now — fine for a demo, but swap for object storage (S3, R2, etc.) before real usage; see the note in `README.md`
