-- Pivô + bombeamento (docs/IOT-PIVO-BOMBEAMENTO.md no front).
-- bombeamento: funcionalidade DO PIVÔ (não é equipamento). Pivôs com a mesma
--   ton_id + bo_liga dividem a bomba (sistema conjugado, automático).
--   { ativo, ton_id, modo: 'pulso'|'mantido', bo_liga, bo_desliga, bi_confirma,
--     confirma_s, pulso_ms }
-- sequencia: tempos da partida { pressurizacao_s (padrão 120), confirma_giro_s (30) }
-- pivo_sequencias: cada "Irrigar ←/→" ou "Desligar" do pivô, passo a passo.
-- Idempotente. ROLLBACK: DROP TABLE pivo_sequencias; ALTER TABLE pivo_config DROP COLUMN bombeamento, DROP COLUMN sequencia;
BEGIN;
ALTER TABLE pivo_config ADD COLUMN IF NOT EXISTS bombeamento jsonb;
ALTER TABLE pivo_config ADD COLUMN IF NOT EXISTS sequencia jsonb;

CREATE TABLE IF NOT EXISTS pivo_sequencias (
  id              char(26)     PRIMARY KEY,
  equipamento_id  char(26)     NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  acao            varchar(20)  NOT NULL,          -- girar_direita | girar_esquerda | desligar
  status          varchar(20)  NOT NULL,          -- executando | concluida | falhou | interrompida
  passos          jsonb        NOT NULL DEFAULT '[]'::jsonb,
  erro            text,
  usuario_id      char(26),
  created_at      timestamp    NOT NULL DEFAULT now(),
  finished_at     timestamp
);
CREATE INDEX IF NOT EXISTS pivo_sequencias_equip_idx ON pivo_sequencias (equipamento_id, created_at DESC);
COMMIT;
