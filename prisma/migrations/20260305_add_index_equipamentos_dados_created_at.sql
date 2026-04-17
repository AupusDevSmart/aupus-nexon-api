-- Migration: Add index on equipamentos_dados.created_at for performance optimization
-- Date: 2026-03-05
-- Context: Health checks and metrics queries were causing full table scans on equipamentos_dados
--          With high data ingestion rates, this caused query times to increase from 6s to 21s+
--          This index enables fast lookup of recent records using time-based windows

-- Create index CONCURRENTLY to avoid locking the table during index creation
-- This allows the system to continue operating normally during the migration
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_equipamentos_dados_created_at
ON equipamentos_dados (created_at DESC);

-- Verify index was created
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'equipamentos_dados'
  AND indexname = 'idx_equipamentos_dados_created_at';
