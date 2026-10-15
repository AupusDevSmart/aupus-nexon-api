-- NEXON-5: automação do pivô no servidor (PivoAutomacaoService) — início agendado,
-- programação de horários, parada automática e pausa/retomada no horário de ponta.
-- Idempotente.
-- ROLLBACK:
--   ALTER TABLE pivo_sequencias DROP COLUMN origem, DROP COLUMN irrigacao, DROP COLUMN parar_em,
--     DROP COLUMN inicio_em, DROP COLUMN retomar;
--   ALTER TABLE pivo_programacoes DROP COLUMN ultima_execucao_em;
ALTER TABLE pivo_sequencias ADD COLUMN IF NOT EXISTS origem varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE pivo_sequencias ADD COLUMN IF NOT EXISTS irrigacao jsonb;
ALTER TABLE pivo_sequencias ADD COLUMN IF NOT EXISTS parar_em timestamptz;
ALTER TABLE pivo_sequencias ADD COLUMN IF NOT EXISTS inicio_em timestamptz;
ALTER TABLE pivo_sequencias ADD COLUMN IF NOT EXISTS retomar jsonb;
CREATE INDEX IF NOT EXISTS pivo_sequencias_agendada_idx ON pivo_sequencias (inicio_em) WHERE status = 'agendada';
ALTER TABLE pivo_programacoes ADD COLUMN IF NOT EXISTS ultima_execucao_em timestamptz;
