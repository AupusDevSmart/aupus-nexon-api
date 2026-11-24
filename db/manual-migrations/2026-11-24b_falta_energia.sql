-- NEXON-145 — Falta de energia avisada pela TON vira chamado na concessionária (Equatorial)
-- pelo robô de WhatsApp do WhatsAupus (Evolution), com o protocolo de volta no chamado.
--
-- Cada linha é um aviso de falta numa unidade (UC). Fluxo do status:
--   AGUARDANDO  → falta recebida, esperando a confirmação (piscada não abre chamado)
--   CANCELADO   → a energia voltou antes da confirmação: nada aberto
--   ENVIANDO    → chamado aberto no NexON, mandando para o robô do WhatsAupus (com retentativa)
--   NO_ROBO     → o robô está conversando com a Clara (ou um atendente assumiu)
--   PROTOCOLO   → protocolo recebido e gravado no chamado
--   SEM_DADOS   → chamado aberto, mas falta UC/concessionária/robô: abrir na mão
--   FALHOU      → robô ou WhatsAupus recusou de vez: abrir na mão
--
-- Depende de 2026-11-24_chamados_externos.sql (NEXON-144): o chamado é tipo EXTERNO.
-- Idempotente. Rollback: DROP TABLE IF EXISTS falta_energia_eventos;
BEGIN;

CREATE TABLE IF NOT EXISTS falta_energia_eventos (
  id                   varchar(26) PRIMARY KEY,
  equipamento_id       varchar(26),            -- TON que avisou (null quando manual sem TON)
  unidade_id           varchar(26),
  planta_id            varchar(26) NOT NULL,
  chave                varchar(60) NOT NULL,   -- agrupa avisos da mesma UC: 'u:<unidade>' ou 'p:<planta>'
  origem               varchar(10) NOT NULL DEFAULT 'TON' CHECK (origem IN ('TON', 'MANUAL')),
  status               varchar(12) NOT NULL DEFAULT 'AGUARDANDO'
                       CHECK (status IN ('AGUARDANDO', 'CANCELADO', 'ENVIANDO', 'NO_ROBO', 'PROTOCOLO', 'SEM_DADOS', 'FALHOU')),
  inicio_em            timestamp(0) NOT NULL,  -- quando faltou (relógio da TON, se veio)
  fim_em               timestamp(0),           -- quando voltou
  chamado_id           varchar(26),
  uc                   varchar(30),
  concessionaria       varchar(120),
  whatsaupus_id        varchar(40),            -- id da reclamação no WhatsAupus (equatorial_complaint)
  protocolo            varchar(40),
  tentativas           integer NOT NULL DEFAULT 0,
  ultimo_erro          varchar(500),
  callback_token_hash  varchar(64),            -- sha256 do token da URL de retorno do WhatsAupus
  callback_em          timestamp(0),
  avisos               integer NOT NULL DEFAULT 1, -- quantos avisos de falta caíram neste evento
  payload_ton          jsonb,
  autor_id             varchar(26),
  autor_nome           varchar(255),
  created_at           timestamp(0) NOT NULL DEFAULT now(),
  updated_at           timestamp(0) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS falta_energia_eventos_abertos_idx ON falta_energia_eventos (chave) WHERE fim_em IS NULL;
CREATE INDEX IF NOT EXISTS falta_energia_eventos_status_idx  ON falta_energia_eventos (status, inicio_em);
CREATE INDEX IF NOT EXISTS falta_energia_eventos_chamado_idx ON falta_energia_eventos (chamado_id);
CREATE INDEX IF NOT EXISTS falta_energia_eventos_planta_idx  ON falta_energia_eventos (planta_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS falta_energia_eventos_token_uq ON falta_energia_eventos (callback_token_hash)
  WHERE callback_token_hash IS NOT NULL;

COMMIT;
