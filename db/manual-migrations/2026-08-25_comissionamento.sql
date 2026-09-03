-- Comissionamento IoT (Fase 0): registro de aceite de coerência de dado por ponto.
-- 1 linha por equipamento (upsert por equipamento_id). Fora do Prisma model — usado via raw.
-- Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.

CREATE TABLE IF NOT EXISTS iot_comissionamento (
  id                     char(26) PRIMARY KEY,
  equipamento_id         char(26) NOT NULL,
  status                 varchar(30) NOT NULL DEFAULT 'pendente', -- pendente|comissionado|comissionado_com_ressalva
  resultado              jsonb,      -- ChecksResult no momento do sign-off
  snapshot               jsonb,      -- leitura usada como baseline
  observacoes            text,
  comissionado_por       char(26),
  comissionado_por_nome  varchar(120),
  comissionado_em        timestamp,
  created_at             timestamp NOT NULL DEFAULT now(),
  updated_at             timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_comissionamento_equip
  ON iot_comissionamento (equipamento_id);
