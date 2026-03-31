/**
 * SwimSync — Cloudflare Worker Backend
 * Routes: /api/create-upload, /api/complete-upload, /api/videos, /api/videos/:id, /api/videos/:id/tags
 */

import { Router } from 'itty-router';
import { createClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';

const router = Router();

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',           // tighten to your GitHub Pages domain in prod
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function errorResponse(msg, status = 400) {
  return corsResponse({ error: msg }, status);
}

router.options('*', () => new Response(null, { status: 204, headers: CORS_HEADERS }));

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Verify the Bearer token from the Authorization header.
 * Returns the Supabase user object or null.
 */
async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const supabase = getSupabase(env);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * Check that the authenticated user has role = 'uploader' in the users table.
 */
async function hasUploaderRole(userId, env) {
  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (error || !data) return false;
  return data.role === 'uploader';
}

/**
 * Build a presigned PUT URL for R2 using AWS Signature V4.
 * The Worker R2 binding only exposes put/get/delete directly — for a presigned
 * URL we sign against R2's S3-compatible endpoint.
 */
async function createPresignedGetUrl(env, objectKey, expiresInSeconds = 3600) {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
  });

  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${objectKey}`
  );
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));

  const signed = await aws.sign(
    new Request(url.toString(), { method: 'GET' }),
    { aws: { signQuery: true } }
  );

  return signed.url;
}

async function createPresignedPutUrl(env, objectKey, contentType, expiresInSeconds = 900) {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
  });

  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${objectKey}`
  );
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));

  const signed = await aws.sign(
    new Request(url.toString(), { method: 'PUT', headers: { 'Content-Type': contentType } }),
    { aws: { signQuery: true } }
  );

  return signed.url;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * POST /api/create-upload
 * Body: { filename, contentType, fileSize, meetId, title }
 */
router.post('/api/create-upload', async (request, env) => {
  const user = await verifyAuth(request, env);
  if (!user) return errorResponse('Unauthorized', 401);

  const isUploader = await hasUploaderRole(user.id, env);
  if (!isUploader) return errorResponse('Forbidden: uploader role required', 403);

  let body;
  try { body = await request.json(); }
  catch { return errorResponse('Invalid JSON body'); }

  const { filename, contentType, fileSize, meetId, title } = body;

  // Validate MIME type
  const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
  if (!ALLOWED_TYPES.includes(contentType)) {
    return errorResponse(`Unsupported content type: ${contentType}`);
  }

  // Validate file size (max 2 GB)
  const MAX_BYTES = 2 * 1024 * 1024 * 1024;
  if (!fileSize || fileSize > MAX_BYTES) {
    return errorResponse('File size must be > 0 and ≤ 2 GB');
  }

  if (!title) return errorResponse('title is required');

  // Generate a unique object key
  const ext = filename?.split('.').pop() ?? 'mp4';
  const objectKey = `videos/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  // Create an upload_session record in Supabase
  const supabase = getSupabase(env);
  const { data: session, error: sessionErr } = await supabase
    .from('upload_sessions')
    .insert({
      uploader_id: user.id,
      object_key: objectKey,
      content_type: contentType,
      file_size: fileSize,
      meet_id: meetId,
      title,
      status: 'pending',
    })
    .select()
    .single();

  if (sessionErr) {
    console.error('upload_session insert error:', sessionErr);
    return errorResponse('Failed to create upload session', 500);
  }

  // Generate the presigned PUT URL
  let uploadUrl;
  try {
    uploadUrl = await createPresignedPutUrl(env, objectKey, contentType);
  } catch (err) {
    console.error('presign error:', err);
    return errorResponse('Failed to generate upload URL', 500);
  }

  return corsResponse({ uploadUrl, objectKey, sessionId: session.id });
});

/**
 * POST /api/complete-upload
 * Body: { objectKey, sessionId, duration? }
 */
router.post('/api/complete-upload', async (request, env) => {
  const user = await verifyAuth(request, env);
  if (!user) return errorResponse('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return errorResponse('Invalid JSON body'); }

  const { objectKey, sessionId, duration } = body;
  if (!objectKey || !sessionId) return errorResponse('objectKey and sessionId are required');

  // Verify the object exists in R2
  const r2Object = await env.R2_BUCKET.head(objectKey);
  if (!r2Object) return errorResponse('Object not found in storage — upload may have failed', 404);

  const supabase = getSupabase(env);

  // Load the upload_session
  const { data: session, error: sessErr } = await supabase
    .from('upload_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('uploader_id', user.id)
    .single();

  if (sessErr || !session) return errorResponse('Upload session not found', 404);
  if (session.status !== 'pending') return errorResponse('Upload session already completed');

  // Write the video metadata row
  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .insert({
      meet_id: session.meet_id,
      uploader_id: user.id,
      title: session.title,
      file_key: objectKey,
      file_size: r2Object.size,
      duration: duration ?? null,
      status: 'ready',
    })
    .select()
    .single();

  if (videoErr) {
    console.error('video insert error:', videoErr);
    return errorResponse('Failed to save video metadata', 500);
  }

  // Mark the upload_session as complete
  await supabase
    .from('upload_sessions')
    .update({ status: 'completed', video_id: video.id })
    .eq('id', sessionId);

  return corsResponse({ video });
});

/**
 * GET /api/videos
 * Public — returns all ready videos with meet/team info.
 * Optional query params: ?meet_id=&limit=&offset=
 */
router.get('/api/videos', async (request, env) => {
  const url = new URL(request.url);
  const meetId = url.searchParams.get('meet_id');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const offset = Number(url.searchParams.get('offset') ?? 0);

  const supabase = getSupabase(env);
  let query = supabase
    .from('videos')
    .select(`
      id, title, file_key, file_size, duration, status, created_at,
      meet:meets(id, name, date),
      uploader:users(id, display_name)
    `)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (meetId) query = query.eq('meet_id', meetId);

  const { data, error } = await query;
  if (error) return errorResponse('Failed to fetch videos', 500);

  return corsResponse({ videos: data, limit, offset });
});

/**
 * GET /api/videos/:id
 * Public — returns metadata for a single video.
 */
router.get('/api/videos/:id', async ({ params }, env) => {
  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from('videos')
    .select(`
      id, title, file_key, file_size, duration, status, created_at,
      meet:meets(id, name, date),
      uploader:users(id, display_name),
      tags(id, swimmer_id, start_time, end_time, note, swimmer:swimmers(id, name))
    `)
    .eq('id', params.id)
    .eq('status', 'ready')
    .single();

  if (error || !data) return errorResponse('Video not found', 404);
  return corsResponse({ video: data });
});

/**
 * POST /api/videos/:id/tags
 * Authenticated — add swimmer tags to a video clip.
 * Body: { swimmerId, startTime, endTime, note? }
 */
router.post('/api/videos/:id/tags', async (request, env) => {
  const user = await verifyAuth(request, env);
  if (!user) return errorResponse('Unauthorized', 401);

  const { params } = request;
  let body;
  try { body = await request.json(); }
  catch { return errorResponse('Invalid JSON body'); }

  const { swimmerId, startTime, endTime, note } = body;
  if (!swimmerId) return errorResponse('swimmerId is required');

  const supabase = getSupabase(env);

  // Confirm the video exists
  const { data: video } = await supabase
    .from('videos')
    .select('id')
    .eq('id', params.id)
    .single();
  if (!video) return errorResponse('Video not found', 404);

  const { data: tag, error } = await supabase
    .from('tags')
    .insert({
      video_id: params.id,
      swimmer_id: swimmerId,
      tagged_by: user.id,
      start_time: startTime ?? null,
      end_time: endTime ?? null,
      note: note ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error('tag insert error:', error);
    return errorResponse('Failed to save tag', 500);
  }

  return corsResponse({ tag }, 201);
});

/**
 * GET /api/videos/:id/url
 * Public — returns a short-lived presigned GET URL to stream the video from R2.
 */
router.get('/api/videos/:id/url', async ({ params }, env) => {
  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from('videos')
    .select('file_key')
    .eq('id', params.id)
    .eq('status', 'ready')
    .single();

  if (error || !data) return errorResponse('Video not found', 404);

  try {
    const url = await createPresignedGetUrl(env, data.file_key);
    return corsResponse({ url });
  } catch (err) {
    console.error('presign get error:', err);
    return errorResponse('Failed to generate video URL', 500);
  }
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────

router.all('*', () => errorResponse('Not Found', 404));

// ─── WORKER ENTRY ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      return await router.fetch(request, env, ctx) ?? errorResponse('Not Found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal Server Error', 500);
    }
  },
};
