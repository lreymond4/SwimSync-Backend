/**
 * SwimSync — recorder.js
 * Drop this into your recorder.html (replace the localStorage simulation).
 *
 * Dependencies (add to <head>):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 *
 * Usage:
 *   1. Set SWIMSYNC_API and SUPABASE_* constants below.
 *   2. Call initAuth() on page load.
 *   3. Call uploadVideo(file, { meetId, title }) to upload a video.
 */

const SWIMSYNC_API   = 'https://swimsync-api.<YOUR_SUBDOMAIN>.workers.dev'; // ← replace
const SUPABASE_URL   = 'https://<YOUR_PROJECT>.supabase.co';                // ← replace
const SUPABASE_ANON  = '<YOUR_SUPABASE_ANON_KEY>';                          // ← replace

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Call on page load. Redirects to login if not authenticated.
 */
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    // Show login UI or redirect — adjust to your design
    showLoginForm();
    return null;
  }
  return session;
}

async function login(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

async function logout() {
  await sb.auth.signOut();
  window.location.reload();
}

function getAccessToken() {
  // Returns the current JWT synchronously from the in-memory session
  return sb.auth.session?.access_token ?? null;
}

// ── Upload flow ───────────────────────────────────────────────────────────────

/**
 * Full upload flow:
 *  1. POST /api/create-upload  → get presigned URL + objectKey
 *  2. PUT <presigned URL>      → stream file directly to R2
 *  3. POST /api/complete-upload → save metadata to Supabase
 *
 * @param {File}   file        — A File object from <input type="file">
 * @param {object} meta        — { meetId: string, title: string }
 * @param {function} onProgress — optional (0-100) progress callback
 */
async function uploadVideo(file, { meetId, title }, onProgress) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const token = session.access_token;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Step 1 — create-upload
  const createRes = await fetch(`${SWIMSYNC_API}/api/create-upload`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename:    file.name,
      contentType: file.type,
      fileSize:    file.size,
      meetId,
      title,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err.error ?? `create-upload failed (${createRes.status})`);
  }

  const { uploadUrl, objectKey, sessionId } = await createRes.json();

  // Step 2 — PUT directly to R2 (frontend never sees credentials)
  await uploadWithProgress(uploadUrl, file, onProgress);

  // Step 3 — complete-upload
  const completeRes = await fetch(`${SWIMSYNC_API}/api/complete-upload`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ objectKey, sessionId }),
  });

  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(err.error ?? `complete-upload failed (${completeRes.status})`);
  }

  const { video } = await completeRes.json();
  return video;
}

/**
 * PUT a file to a presigned URL with XHR-based progress reporting.
 */
function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed: ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.send(file);
  });
}

// ── Example wiring to your existing UI ───────────────────────────────────────
// Replace the localStorage-based queue with this in your recorder.html:
//
// document.getElementById('upload-btn').addEventListener('click', async () => {
//   const file    = document.getElementById('file-input').files[0];
//   const meetId  = document.getElementById('meet-select').value;
//   const title   = document.getElementById('title-input').value;
//
//   try {
//     showStatus('Uploading…');
//     const video = await uploadVideo(file, { meetId, title }, (pct) => {
//       document.getElementById('progress-bar').style.width = pct + '%';
//     });
//     showStatus(`Done! Video ID: ${video.id}`);
//   } catch (err) {
//     showStatus(`Error: ${err.message}`, 'error');
//   }
// });
