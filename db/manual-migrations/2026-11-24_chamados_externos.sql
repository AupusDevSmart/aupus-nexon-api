-- NEXON-144 — Chamados externos: o que a Aupus abre com terceiros (ex.: falta de energia na rua,
-- aberta com a Equatorial). Mesmo módulo dos chamados de reparo (NEXON-24), com `tipo`:
--   INTERNO = reparo de equipamento (fluxo ABERTO → ENCAMINHADO → FECHADO, já existia)
--   EXTERNO = aberto com órgão/empresa de fora (ABERTO → EM_ANDAMENTO → RESOLVIDO | CANCELADO)
-- Externo vincula à planta (obrigatória), unidade e equipamento (opcionais), com protocolo,
-- início da ocorrência, abertura no órgão, previsão e resolução. Histórico em chamados_atualizacoes.
-- Auditoria em auditoria_acessos (acao chamado_*). Idempotente.
-- Rollback:
--   DROP TABLE IF EXISTS chamados_atualizacoes;
--   ALTER TABLE chamados DROP COLUMN IF EXISTS tipo, DROP COLUMN IF EXISTS orgao,
--     DROP COLUMN IF EXISTS protocolo, DROP COLUMN IF EXISTS ocorrencia_em,
--     DROP COLUMN IF EXISTS aberto_em, DROP COLUMN IF EXISTS previsao_em;
--   (status/motivo: recriar os CHECK do 2026-10-20c; equipamento_id NOT NULL só sem externos)
BEGIN;

ALTER TABLE chamados ADD COLUMN IF NOT EXISTS tipo varchar(10) NOT NULL DEFAULT 'INTERNO';
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS orgao varchar(120);          -- "Equatorial", "Prefeitura"...
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS protocolo varchar(80);       -- número dado pelo órgão
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS ocorrencia_em timestamp(0);  -- quando o problema começou
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS aberto_em timestamp(0);      -- quando foi aberto no órgão
ALTER TABLE chamados ADD COLUMN IF NOT EXISTS previsao_em timestamp(0);    -- previsão dada pelo órgão
ALTER TABLE chamados ALTER COLUMN equipamento_id DROP NOT NULL;            -- externo pode ser só da planta

ALTER TABLE chamados DROP CONSTRAINT IF EXISTS chamados_tipo_check;
ALTER TABLE chamados ADD CONSTRAINT chamados_tipo_check CHECK (tipo IN ('INTERNO', 'EXTERNO'));

ALTER TABLE chamados DROP CONSTRAINT IF EXISTS chamados_status_check;
ALTER TABLE chamados ADD CONSTRAINT chamados_status_check
  CHECK (status IN ('ABERTO', 'ENCAMINHADO', 'FECHADO', 'EM_ANDAMENTO', 'RESOLVIDO', 'CANCELADO'));

ALTER TABLE chamados DROP CONSTRAINT IF EXISTS chamados_motivo_check;
ALTER TABLE chamados ADD CONSTRAINT chamados_motivo_check
  CHECK (motivo IN ('FALHA', 'ALARME', 'CAMPO', 'OUTRO',
                    'FALTA_ENERGIA', 'OSCILACAO', 'REDE', 'MEDICAO', 'RELIGACAO'));

-- Interno precisa de equipamento; externo precisa de planta.
ALTER TABLE chamados DROP CONSTRAINT IF EXISTS chamados_vinculo_check;
ALTER TABLE chamados ADD CONSTRAINT chamados_vinculo_check
  CHECK ((tipo = 'INTERNO' AND equipamento_id IS NOT NULL) OR (tipo = 'EXTERNO' AND planta_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS chamados_tipo_idx      ON chamados (tipo, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS chamados_protocolo_idx ON chamados (protocolo) WHERE protocolo IS NOT NULL;

-- Linha do tempo do chamado: nota livre ("liguei de novo, nova previsão 18h"), troca de status e edição.
CREATE TABLE IF NOT EXISTS chamados_atualizacoes (
  id              varchar(26) PRIMARY KEY,
  chamado_id      varchar(26) NOT NULL REFERENCES chamados (id) ON DELETE CASCADE,
  tipo            varchar(10) NOT NULL CHECK (tipo IN ('NOTA', 'STATUS', 'EDICAO')),
  status_anterior varchar(12),
  status_novo     varchar(12),
  texto           varchar(2000),
  autor_id        varchar(26),
  autor_nome      varchar(255),
  created_at      timestamp(0) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chamados_atualizacoes_chamado_idx ON chamados_atualizacoes (chamado_id, created_at);

COMMIT;
