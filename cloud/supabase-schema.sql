-- Supabase (PostgreSQL) schema for the Furry of Madness website.
--
-- This database does NOT hold the game. AzerothCore is MySQL-only, and the
-- game DBs stay on the server machine. What lives here is only what the public
-- website needs: a status snapshot, a leaderboard, news, and a registration
-- queue that the home-side agent drains.
--
-- Data flow (the home machine never accepts inbound connections):
--
--     home agent  ──push status/leaderboard──▶  Supabase  ◀──read──  Vercel site
--     home agent  ◀──poll pending registrations──┘         ◀──insert──┘
--
-- Run this once in the Supabase SQL editor.

-- ─────────────────────────────────────────── server status (single row)
create table if not exists server_status (
    id               int primary key default 1,
    updated_at       timestamptz not null default now(),
    online           boolean     not null default false,
    players_online   int         not null default 0,
    bots_online      int         not null default 0,
    characters_total int         not null default 0,
    realm_address    text,
    realm_name       text,
    uptime_sec       int,
    tick_max_ms      int,
    constraint server_status_singleton check (id = 1)
);
insert into server_status (id) values (1) on conflict (id) do nothing;

-- ─────────────────────────────────────────── leaderboard
create table if not exists leaderboard (
    guid        int primary key,
    name        text not null,
    level       int  not null,
    race        int,
    class       int,
    played_sec  int,
    is_bot      boolean not null default false,
    updated_at  timestamptz not null default now()
);
create index if not exists leaderboard_level_idx on leaderboard (level desc, played_sec desc);

-- ─────────────────────────────────────────── news
create table if not exists news (
    id         bigserial primary key,
    title      text not null,
    body       text not null,
    published  boolean not null default true,
    created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────── registration queue
--
-- SECURITY: `password` is written by the public site and read exactly once by
-- the agent, which then nulls it. AzerothCore derives an SRP6 verifier from the
-- plaintext, so it cannot be pre-hashed here. RLS below lets anon INSERT but
-- never SELECT, so a leaked anon key cannot read pending passwords.
create table if not exists registrations (
    id           uuid primary key default gen_random_uuid(),
    username     text not null,
    password     text,
    status       text not null default 'pending',
    error        text,
    created_at   timestamptz not null default now(),
    processed_at timestamptz,
    constraint registrations_status_chk check (status in ('pending','done','error')),
    constraint registrations_username_chk check (username ~ '^[A-Za-z0-9_-]{1,16}$')
);
create unique index if not exists registrations_username_uidx
    on registrations (lower(username));
create index if not exists registrations_pending_idx
    on registrations (status) where status = 'pending';

-- ─────────────────────────────────────────── row level security
alter table server_status enable row level security;
alter table leaderboard   enable row level security;
alter table news          enable row level security;
alter table registrations enable row level security;

-- Public pages read status, leaderboard and news.
drop policy if exists status_read on server_status;
create policy status_read on server_status for select to anon, authenticated using (true);

drop policy if exists leaderboard_read on leaderboard;
create policy leaderboard_read on leaderboard for select to anon, authenticated using (true);

drop policy if exists news_read on news;
create policy news_read on news for select to anon, authenticated using (published);

-- Anyone may SUBMIT a registration; nobody may read the queue back.
-- Deliberately no SELECT policy on registrations - the site checks availability
-- through a SECURITY DEFINER function instead, so passwords stay unreadable.
drop policy if exists registrations_insert on registrations;
create policy registrations_insert on registrations
    for insert to anon, authenticated
    with check (status = 'pending' and password is not null);

-- The agent uses the service_role key, which bypasses RLS entirely.

-- ─────────────────────────────────────────── helpers
-- Availability check that does not expose the queue.
create or replace function username_available(candidate text)
returns boolean
language sql
security definer
set search_path = public
as $$
    select not exists (
        select 1 from registrations where lower(username) = lower(candidate)
    );
$$;
revoke all on function username_available(text) from public;
grant execute on function username_available(text) to anon, authenticated;

-- Status freshness, so the site can show "stale" instead of lying about uptime.
create or replace function status_is_fresh()
returns boolean
language sql
stable
as $$
    select coalesce(now() - updated_at < interval '2 minutes', false) from server_status where id = 1;
$$;
grant execute on function status_is_fresh() to anon, authenticated;
