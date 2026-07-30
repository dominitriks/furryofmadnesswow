-- Admin layer for the Furry of Madness site.
--
-- The browser can NEVER hold the service_role key - anyone can read a web
-- page's source. So admin access is real Supabase Auth (JWT) plus RLS keyed on
-- auth.uid(), and every privileged read goes through a SECURITY DEFINER
-- function that checks membership first.
--
-- Game-server actions cannot run from the browser either: MySQL and the
-- worldserver console live on the server machine and accept no inbound
-- connections. So the site QUEUES a command here and the home agent drains it,
-- exactly like the registration queue that is already proven working.
--
-- Run after supabase-schema.sql.

-- ─────────────────────────────────────────── who is an admin
create table if not exists admins (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    note       text,
    created_at timestamptz not null default now()
);

-- SECURITY DEFINER on purpose: if this read went through RLS it would recurse
-- (the policy on `admins` would call the function that reads `admins`).
create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from admins where user_id = auth.uid());
$$;
revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated;

alter table admins enable row level security;
drop policy if exists admins_self_read on admins;
create policy admins_self_read on admins
    for select to authenticated
    using (user_id = auth.uid());

-- ─────────────────────────────────────────── command queue
create table if not exists admin_commands (
    id           uuid primary key default gen_random_uuid(),
    created_by   uuid references auth.users (id),
    kind         text not null,
    payload      jsonb not null default '{}'::jsonb,
    status       text not null default 'pending',
    result       text,
    created_at   timestamptz not null default now(),
    processed_at timestamptz,
    constraint admin_commands_kind_chk check (kind in (
        'console', 'account_create', 'account_gmlevel', 'account_password',
        'account_delete', 'server_start', 'server_stop', 'server_restart'
    )),
    constraint admin_commands_status_chk check (status in ('pending','done','error'))
);
create index if not exists admin_commands_pending_idx
    on admin_commands (created_at) where status = 'pending';

alter table admin_commands enable row level security;

drop policy if exists admin_commands_insert on admin_commands;
create policy admin_commands_insert on admin_commands
    for insert to authenticated
    with check (is_admin() and created_by = auth.uid() and status = 'pending');

drop policy if exists admin_commands_read on admin_commands;
create policy admin_commands_read on admin_commands
    for select to authenticated
    using (is_admin());

-- The agent uses service_role, which bypasses RLS, to update status/result.

-- ─────────────────────────────────────────── privileged reads
-- Registration queue WITHOUT the password column. Even a signed-in admin has no
-- reason to read a pending player's plaintext password, and not exposing it
-- means a stolen admin session cannot harvest them.
create or replace function admin_registrations()
returns table (
    id uuid, username text, status text, error text,
    created_at timestamptz, processed_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
    select r.id, r.username, r.status, r.error, r.created_at, r.processed_at
    from registrations r
    where is_admin()
    order by r.created_at desc
    limit 100;
$$;
revoke all on function admin_registrations() from public;
grant execute on function admin_registrations() to authenticated;

-- ─────────────────────────────────────────── news management
drop policy if exists news_admin_write on news;
create policy news_admin_write on news
    for all to authenticated
    using (is_admin())
    with check (is_admin());
