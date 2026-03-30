-- ============================================================
-- SwimSync — Supabase Postgres Schema
-- Run this entire file in the Supabase SQL editor.
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── teams ────────────────────────────────────────────────────
create table public.teams (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  short_code   text unique,          -- e.g. "BLTC"
  logo_url     text,
  created_at   timestamptz not null default now()
);

-- ── users (mirrors auth.users, extends with app-level fields) ─
-- Supabase Auth already manages auth.users.
-- We keep a public profile table that is joined in queries.
create table public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email        text,
  role         text not null default 'viewer'
                 check (role in ('viewer', 'uploader', 'admin')),
  team_id      uuid references public.teams(id),
  avatar_url   text,
  created_at   timestamptz not null default now()
);

-- Automatically create a public.users row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── meets ────────────────────────────────────────────────────
create table public.meets (
  id           uuid primary key default uuid_generate_v4(),
  team_id      uuid references public.teams(id),
  name         text not null,
  location     text,
  date         date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ── sessions (heats / warm-up blocks within a meet) ──────────
create table public.sessions (
  id           uuid primary key default uuid_generate_v4(),
  meet_id      uuid not null references public.meets(id) on delete cascade,
  label        text not null,          -- e.g. "Morning Warm-up", "Heat 3"
  starts_at    timestamptz,
  created_at   timestamptz not null default now()
);

-- ── swimmers ─────────────────────────────────────────────────
create table public.swimmers (
  id           uuid primary key default uuid_generate_v4(),
  team_id      uuid references public.teams(id),
  name         text not null,
  date_of_birth date,
  lane_default  int,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ── videos ───────────────────────────────────────────────────
create table public.videos (
  id           uuid primary key default uuid_generate_v4(),
  meet_id      uuid references public.meets(id),
  session_id   uuid references public.sessions(id),
  uploader_id  uuid not null references public.users(id),
  title        text not null,
  file_key     text not null unique,   -- R2 object key
  file_size    bigint,                 -- bytes
  duration     numeric(10,3),          -- seconds
  status       text not null default 'pending'
                 check (status in ('pending', 'ready', 'error', 'deleted')),
  created_at   timestamptz not null default now()
);

create index videos_meet_id_idx        on public.videos(meet_id);
create index videos_uploader_id_idx    on public.videos(uploader_id);
create index videos_status_idx         on public.videos(status);
create index videos_created_at_idx     on public.videos(created_at desc);

-- ── tags ─────────────────────────────────────────────────────
create table public.tags (
  id           uuid primary key default uuid_generate_v4(),
  video_id     uuid not null references public.videos(id) on delete cascade,
  swimmer_id   uuid not null references public.swimmers(id),
  tagged_by    uuid references public.users(id),
  start_time   numeric(10,3),   -- seconds into video
  end_time     numeric(10,3),
  note         text,
  created_at   timestamptz not null default now()
);

create index tags_video_id_idx    on public.tags(video_id);
create index tags_swimmer_id_idx  on public.tags(swimmer_id);

-- ── upload_sessions ──────────────────────────────────────────
-- Tracks in-flight uploads; cleaned up once complete.
create table public.upload_sessions (
  id            uuid primary key default uuid_generate_v4(),
  uploader_id   uuid not null references public.users(id),
  object_key    text not null unique,   -- R2 key reserved for this upload
  content_type  text not null,
  file_size     bigint,
  meet_id       uuid references public.meets(id),
  title         text,
  status        text not null default 'pending'
                  check (status in ('pending', 'completed', 'failed')),
  video_id      uuid references public.videos(id),   -- filled on completion
  expires_at    timestamptz not null default (now() + interval '30 minutes'),
  created_at    timestamptz not null default now()
);

create index upload_sessions_uploader_idx on public.upload_sessions(uploader_id);
create index upload_sessions_expires_idx  on public.upload_sessions(expires_at);

-- ── Row Level Security ────────────────────────────────────────
-- The Worker uses the service_role key and bypasses RLS.
-- Enable RLS for future direct-from-browser queries (viewer page, etc.).

alter table public.teams          enable row level security;
alter table public.users          enable row level security;
alter table public.meets          enable row level security;
alter table public.sessions       enable row level security;
alter table public.swimmers       enable row level security;
alter table public.videos         enable row level security;
alter table public.tags           enable row level security;
alter table public.upload_sessions enable row level security;

-- Public read on teams, meets, sessions, swimmers, videos, tags
create policy "public read teams"    on public.teams     for select using (true);
create policy "public read meets"    on public.meets     for select using (true);
create policy "public read sessions" on public.sessions  for select using (true);
create policy "public read swimmers" on public.swimmers  for select using (true);
create policy "public read videos"   on public.videos    for select using (status = 'ready');
create policy "public read tags"     on public.tags      for select using (true);

-- Users can read their own profile
create policy "users read own"       on public.users
  for select using (auth.uid() = id);

-- Uploaders can read their own upload_sessions
create policy "uploader read own sessions" on public.upload_sessions
  for select using (auth.uid() = uploader_id);

-- ── Seed: demo team + meet (optional, delete if not needed) ──
insert into public.teams (id, name, short_code)
values ('00000000-0000-0000-0000-000000000001', 'Demo Team', 'DEMO')
on conflict do nothing;

insert into public.meets (id, team_id, name, location, date)
values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'Spring Invitational 2025',
  'Aquatic Center',
  '2025-04-12'
) on conflict do nothing;
