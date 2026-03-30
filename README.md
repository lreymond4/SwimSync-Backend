# SwimSync Backend — Setup & Deployment Guide

## Architecture Overview

```
GitHub Pages (frontend)
        │
        │  HTTPS  (JWT in Authorization header)
        ▼
Cloudflare Worker  ──► Supabase (auth verify + Postgres metadata)
        │
        │  presigned PUT URL (returned to browser)
        │
        ▼
Browser ──► R2 (direct file upload, no credentials exposed)
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| Wrangler CLI | ≥ 3 | `npm i -g wrangler` |
| Supabase account | — | https://supabase.com |
| Cloudflare account | — | https://dash.cloudflare.com |

---

## Step 1 — Create the Supabase Project

1. Go to https://supabase.com/dashboard → **New project**
2. Choose a name (e.g. `swimsync`), a strong DB password, and a region close to your users.
3. Wait for the project to provision (~1 min).
4. Open **SQL Editor** → paste the full contents of `supabase/schema.sql` → click **Run**.
5. Collect the following from **Settings → API**:
   - **Project URL** → `SUPABASE_URL`
   - **`anon` public key** → goes in the frontend `recorder.js`
   - **`service_role` secret key** → `SUPABASE_SERVICE_ROLE_KEY` *(keep this private)*

### Grant uploader role to a user

After a user signs up, run this in the SQL editor (replace the email):

```sql
update public.users
set role = 'uploader'
where email = 'coach@example.com';
```

---

## Step 2 — Create the Cloudflare R2 Bucket

1. Log in to https://dash.cloudflare.com → **R2 Object Storage** → **Create bucket**
2. Name it **`swimsync-videos`** (must match `wrangler.toml` → `bucket_name`).
3. Leave all defaults; do **not** enable public access (the Worker gates access).
4. Create an **R2 API Token** for the Worker to sign presigned URLs:
   - Go to **R2 → Manage R2 API Tokens → Create API Token**
   - Permissions: **Object Read & Write** on the `swimsync-videos` bucket
   - Copy the **Access Key ID** → `R2_ACCESS_KEY_ID`
   - Copy the **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
5. Your **Account ID** (shown top-right of the dashboard) → `R2_ACCOUNT_ID`

---

## Step 3 — Deploy the Cloudflare Worker

### 3.1  Install dependencies

```bash
cd swimsync-backend
npm install
```

### 3.2  Authenticate Wrangler

```bash
wrangler login
```

### 3.3  Set secrets (never committed to git)

Run each command and paste the value when prompted:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_BUCKET_NAME        # value: swimsync-videos
```

### 3.4  Deploy

```bash
npm run deploy
```

Wrangler will print a URL like:
```
https://swimsync-api.<your-subdomain>.workers.dev
```

Copy this — it is your `SWIMSYNC_API` base URL.

### 3.5  Verify

```bash
curl https://swimsync-api.<your-subdomain>.workers.dev/api/videos
# → { "videos": [], "limit": 50, "offset": 0 }
```

---

## Step 4 — Connect the Frontend Recorder

1. Copy `frontend/recorder.js` into your GitHub Pages repo alongside `recorder.html`.

2. Edit the three constants at the top of `recorder.js`:

```js
const SWIMSYNC_API  = 'https://swimsync-api.<YOUR_SUBDOMAIN>.workers.dev';
const SUPABASE_URL  = 'https://<YOUR_PROJECT>.supabase.co';
const SUPABASE_ANON = '<YOUR_SUPABASE_ANON_KEY>';
```

3. In `recorder.html`, add before `</body>`:

```html
<!-- Supabase JS SDK -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<!-- SwimSync recorder logic -->
<script src="recorder.js"></script>
```

4. Replace the existing `localStorage` upload queue code with calls to `uploadVideo()` and `initAuth()` from `recorder.js` (see the example wiring at the bottom of that file).

5. The viewer page (`viewer.html`) fetches from `GET /api/videos` — no auth needed:

```js
const res = await fetch('https://swimsync-api.<YOUR_SUBDOMAIN>.workers.dev/api/videos');
const { videos } = await res.json();
```

---

## Environment Variables Reference

| Name | Where set | Description |
|------|-----------|-------------|
| `SUPABASE_URL` | Wrangler secret | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Wrangler secret | Service role JWT (bypasses RLS) |
| `R2_ACCESS_KEY_ID` | Wrangler secret | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | Wrangler secret | R2 API token secret |
| `R2_ACCOUNT_ID` | Wrangler secret | Cloudflare account ID |
| `R2_BUCKET_NAME` | Wrangler secret | `swimsync-videos` |

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/create-upload` | Bearer JWT (uploader) | Reserve object key, get presigned PUT URL |
| `POST` | `/api/complete-upload` | Bearer JWT | Verify R2 object exists, write video metadata |
| `GET`  | `/api/videos` | None | List all ready videos |
| `GET`  | `/api/videos/:id` | None | Single video with tags |
| `POST` | `/api/videos/:id/tags` | Bearer JWT | Tag a swimmer in a clip |

### POST /api/create-upload

**Request body:**
```json
{
  "filename":    "race_heat3.mp4",
  "contentType": "video/mp4",
  "fileSize":    104857600,
  "meetId":      "<uuid>",
  "title":       "Heat 3 — 100m Freestyle"
}
```

**Response:**
```json
{
  "uploadUrl":  "https://<account>.r2.cloudflarestorage.com/swimsync-videos/videos/...?X-Amz-...",
  "objectKey":  "videos/<uid>/<timestamp>-<uuid>.mp4",
  "sessionId":  "<uuid>"
}
```

### POST /api/complete-upload

**Request body:**
```json
{
  "objectKey": "videos/...",
  "sessionId": "<uuid>",
  "duration":  142.5
}
```

**Response:**
```json
{ "video": { "id": "...", "title": "...", "status": "ready", ... } }
```

---

## Scaling Notes

- **Storage**: R2 has no egress fees and scales to petabytes. 1 TB is well within its design envelope.
- **Compute**: Workers are stateless and scale automatically.
- **Database**: Supabase Postgres starts at 500 MB free; upgrade to Pro for production workloads. Add `pg_partitioning` on `videos.created_at` once you exceed ~1M rows.
- **Upload size limit**: Currently set to 2 GB per file in the Worker. R2 supports up to 5 TB per object with multipart upload (add `POST /api/create-multipart` when needed).
- **Presigned URL TTL**: 15 minutes by default (`expiresInSeconds = 900` in `createPresignedPutUrl`). Increase for large files on slow connections.

---

## Local Development

```bash
# Start a local Worker (connects to real Supabase/R2 via secrets)
npm run dev

# Stream live Worker logs from production
npm run tail
```

For a fully local setup, create a `.dev.vars` file (git-ignored):

```
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ACCOUNT_ID=...
R2_BUCKET_NAME=swimsync-videos
```
