-- ============================================================================
-- Feature BI (Boolean Input) — ingestão e mapeamento de entradas digitais do TON
-- Data: 2026-06-18
--
-- Por que SQL manual (e não migration do Prisma):
--   O schema.prisma vive no pacote git @aupus/api-shared, hardlinkado ao store
--   pnpm (links=5) — editar corromperia o store global compartilhado entre apps.
--   Além disso o prisma CLI não está instalado neste serviço. Estas tabelas são
--   acessadas via $queryRaw/$executeRaw no nexon-api. `prisma migrate deploy`
--   (fluxo usado em prod) NUNCA dropa tabelas fora do schema, então elas são
--   seguras. Quando conveniente, promover estes models pro repo api-shared
--   (as tabelas já batem — vira no-op) e refatorar pra client tipado.
-- ============================================================================

-- Estado atual de I/O digital por TON (atualizado on-change pelo MQTT).
CREATE TABLE IF NOT EXISTS equipamento_io_estado (
  equipamento_id char(26) PRIMARY KEY REFERENCES equipamentos(id) ON DELETE CASCADE,
  inputs  jsonb,                       -- {d1..d6} (BI)
  outputs jsonb,                       -- {tr1..tr4} (futuro)
  relays  jsonb,                       -- {r1..r6}  (futuro)
  updated_at timestamp(0) without time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE equipamento_io_estado IS
  'Estado atual de I/O digital por TON: inputs (d1-d6/BI), outputs (tr1-4), relays (r1-6). Atualizado on-change pelo MQTT.';

-- Mapeamento BI: ton_id + bi_numero (d1..d6) -> ponto semântico (tipo status).
CREATE TABLE IF NOT EXISTS ton_bi (
  id                   char(26) PRIMARY KEY,
  ton_id               char(26) NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  bi_numero            integer  NOT NULL,
  equipamento_ponto_id char(26) REFERENCES equipamento_pontos(id) ON DELETE SET NULL,
  invertido            boolean  NOT NULL DEFAULT false,   -- contato NF: inverte 0<->1
  ativo                boolean  NOT NULL DEFAULT true,
  created_at           timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at           timestamp(0) without time zone NOT NULL DEFAULT now(),
  deleted_at           timestamp(0) without time zone,
  CONSTRAINT ton_bi_ton_id_bi_numero_key UNIQUE (ton_id, bi_numero)
);
CREATE INDEX IF NOT EXISTS idx_ton_bi_ton   ON ton_bi (ton_id);
CREATE INDEX IF NOT EXISTS idx_ton_bi_ponto ON ton_bi (equipamento_ponto_id);
CREATE INDEX IF NOT EXISTS idx_ton_bi_ativo ON ton_bi (ativo);
COMMENT ON TABLE ton_bi IS
  'Boolean Input: mapeia ton_id + bi_numero (d1-d6) -> equipamento_ponto_id (tipo status). invertido=true para contato NF.';
