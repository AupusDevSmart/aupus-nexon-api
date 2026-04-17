-- Migration: Simplify OS workflow statuses
-- StatusProgramacaoOS: RASCUNHO,PENDENTE,EM_ANALISE,APROVADA,REJEITADA,CANCELADA → PENDENTE,APROVADA,FINALIZADA,CANCELADA
-- StatusOS: PLANEJADA,PROGRAMADA,EM_EXECUCAO,PAUSADA,FINALIZADA,CANCELADA → PENDENTE,EM_EXECUCAO,PAUSADA,EXECUTADA,AUDITADA,FINALIZADA,CANCELADA

-- 1. StatusProgramacaoOS

UPDATE programacoes_os SET status = 'PENDENTE' WHERE status IN ('RASCUNHO', 'EM_ANALISE');
UPDATE programacoes_os SET status = 'CANCELADA' WHERE status = 'REJEITADA';

UPDATE historico_programacao_os SET status_anterior = 'PENDENTE' WHERE status_anterior IN ('RASCUNHO', 'EM_ANALISE');
UPDATE historico_programacao_os SET status_novo = 'PENDENTE' WHERE status_novo IN ('RASCUNHO', 'EM_ANALISE');
UPDATE historico_programacao_os SET status_anterior = 'CANCELADA' WHERE status_anterior = 'REJEITADA';
UPDATE historico_programacao_os SET status_novo = 'CANCELADA' WHERE status_novo = 'REJEITADA';

ALTER TYPE status_programacao_os RENAME TO status_programacao_os_old;
CREATE TYPE status_programacao_os AS ENUM ('PENDENTE', 'APROVADA', 'FINALIZADA', 'CANCELADA');

ALTER TABLE programacoes_os ALTER COLUMN status DROP DEFAULT;
ALTER TABLE programacoes_os ALTER COLUMN status TYPE status_programacao_os USING status::text::status_programacao_os;
ALTER TABLE programacoes_os ALTER COLUMN status SET DEFAULT 'PENDENTE'::status_programacao_os;

ALTER TABLE historico_programacao_os ALTER COLUMN status_anterior TYPE status_programacao_os USING status_anterior::text::status_programacao_os;
ALTER TABLE historico_programacao_os ALTER COLUMN status_novo TYPE status_programacao_os USING status_novo::text::status_programacao_os;

DROP TYPE status_programacao_os_old;

-- 2. StatusOS

ALTER TYPE status_os RENAME TO status_os_old;
CREATE TYPE status_os AS ENUM ('PENDENTE', 'EM_EXECUCAO', 'PAUSADA', 'EXECUTADA', 'AUDITADA', 'FINALIZADA', 'CANCELADA');

ALTER TABLE ordens_servico ALTER COLUMN status DROP DEFAULT;
ALTER TABLE ordens_servico ALTER COLUMN status TYPE status_os USING (CASE WHEN status::text IN ('PLANEJADA','PROGRAMADA') THEN 'PENDENTE' ELSE status::text END)::status_os;
ALTER TABLE ordens_servico ALTER COLUMN status SET DEFAULT 'PENDENTE'::status_os;

ALTER TABLE historico_os ALTER COLUMN status_anterior TYPE status_os USING (CASE WHEN status_anterior::text IN ('PLANEJADA','PROGRAMADA') THEN 'PENDENTE' ELSE status_anterior::text END)::status_os;
ALTER TABLE historico_os ALTER COLUMN status_novo TYPE status_os USING (CASE WHEN status_novo::text IN ('PLANEJADA','PROGRAMADA') THEN 'PENDENTE' ELSE status_novo::text END)::status_os;

DROP TYPE status_os_old;
