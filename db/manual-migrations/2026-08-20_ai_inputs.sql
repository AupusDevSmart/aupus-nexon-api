-- ============================================================================
-- Feature AI (Analog Input) — mapeamento de entradas ANALÓGICAS do TON
-- Data: 2026-08-20
--
-- Espelha ton_bi/ton_bo (ver 2026-06-18_bi_inputs.sql). SQL manual porque o
-- schema.prisma vive no pacote git @aupus/api-shared (hardlinkado ao store pnpm)
-- e o prisma CLI não está instalado neste serviço; acesso via $queryRaw/$executeRaw.
-- `prisma migrate deploy` nunca dropa tabelas fora do schema → seguro.
--
-- Motivação: a bomba de combustível (e futuros equipamentos) lê o NÍVEL do tanque
-- por uma entrada analógica da TON. Antes o canal/escala ficavam presos nas props
-- do componente IoT; agora são configuráveis na TON (Configurar AIs), igual BOs/BIs.
--
-- Escala linear: pct = (mv - mv_0) / (mv_100 - mv_0) * 100.
--   mv_0=0, mv_100=3000  → 0-3000mV = 0-100% (sensor ratiométrico simples).
--   4-20mA (com shunt): mv_0 = mV lidos em 4mA, mv_100 = mV lidos em 20mA.
-- ============================================================================

-- Mapeamento AI: ton_id + ai_numero (canal 1..N) -> ponto semântico (tipo medicao).
CREATE TABLE IF NOT EXISTS ton_ai (
  id                   char(26) PRIMARY KEY,
  ton_id               char(26) NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  ai_numero            integer  NOT NULL,                 -- canal AI da TON (1..2 no v1)
  equipamento_ponto_id char(26) REFERENCES equipamento_pontos(id) ON DELETE SET NULL,
  mv_0                 integer  NOT NULL DEFAULT 0,        -- mV que equivale a 0%
  mv_100               integer  NOT NULL DEFAULT 3000,     -- mV que equivale a 100%
  ativo                boolean  NOT NULL DEFAULT true,
  created_at           timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at           timestamp(0) without time zone NOT NULL DEFAULT now(),
  deleted_at           timestamp(0) without time zone,
  CONSTRAINT ton_ai_ton_id_ai_numero_key UNIQUE (ton_id, ai_numero)
);
CREATE INDEX IF NOT EXISTS idx_ton_ai_ton   ON ton_ai (ton_id);
CREATE INDEX IF NOT EXISTS idx_ton_ai_ponto ON ton_ai (equipamento_ponto_id);
CREATE INDEX IF NOT EXISTS idx_ton_ai_ativo ON ton_ai (ativo);
COMMENT ON TABLE ton_ai IS
  'Analog Input: mapeia ton_id + ai_numero (canal analógico) -> equipamento_ponto_id (tipo medicao). mv_0/mv_100 = escala linear mV->%.';
