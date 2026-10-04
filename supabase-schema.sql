-- ==============================================================================
-- Karnehan Meat Shop POS - Supabase Backup Schema
-- Configured in project: ali assistant (batayolaeugene)
-- ==============================================================================

-- 1. Create the backup table to store POS snapshots
CREATE TABLE IF NOT EXISTS public.meat_pos_backups (
    id TEXT PRIMARY KEY DEFAULT 'current',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    data JSONB NOT NULL
);

-- 2. Index for quick ordering by newest backup
CREATE INDEX IF NOT EXISTS idx_meat_pos_backups_updated_at 
  ON public.meat_pos_backups (updated_at DESC);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.meat_pos_backups ENABLE ROW LEVEL SECURITY;

-- 4. Allow client-side sync access via Publishable API Key
CREATE POLICY "Allow public select" ON public.meat_pos_backups
    FOR SELECT USING (true);

CREATE POLICY "Allow public insert" ON public.meat_pos_backups
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update" ON public.meat_pos_backups
    FOR UPDATE USING (true);
