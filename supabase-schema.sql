-- ==============================================================================
-- Karnehan Meat Shop POS - Supabase Backup Schema
-- Run this script in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- ==============================================================================

-- 1. Create the backup table to store POS snapshots
create table if not exists public.meat_pos_backups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  device_name text default 'Browser POS',
  customer_count integer not null default 0,
  sale_count integer not null default 0,
  total_receivables numeric(12,2) not null default 0,
  payload jsonb not null
);

-- 2. Index for quick ordering by newest backup
create index if not exists idx_meat_pos_backups_created_at 
  on public.meat_pos_backups (created_at desc);

-- 3. Enable Row Level Security (RLS)
alter table public.meat_pos_backups enable row level security;

-- 4. Allow anon / authenticated clients to insert new backups and read history
drop policy if exists "Allow anon insert backups" on public.meat_pos_backups;
create policy "Allow anon insert backups"
  on public.meat_pos_backups
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Allow anon select backups" on public.meat_pos_backups;
create policy "Allow anon select backups"
  on public.meat_pos_backups
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Allow anon delete backups" on public.meat_pos_backups;
create policy "Allow anon delete backups"
  on public.meat_pos_backups
  for delete
  to anon, authenticated
  using (true);
