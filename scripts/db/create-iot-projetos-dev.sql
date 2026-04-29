-- =============================================================================
-- DEV ONLY: Cria iot_projetos no DB de desenvolvimento
-- =============================================================================
--
-- Em PRODUCAO, esta tabela eh criada pela migration do /var/www/iot_nexon/
-- (sistema IoT externo que compartilha o mesmo Postgres). Para dev local,
-- precisamos cria-la manualmente porque o setup do iot_nexon nao roda aqui.
--
-- Esquema minimo: cobre apenas as colunas que aupus-nexon-api/src/modules/iot
-- usa em runtime (id, unidade_id, nome, diagrama, timestamps, soft delete).
-- Em prod a tabela pode ter colunas adicionais geridas pelo iot_nexon — nao
-- mexer.
--
-- Idempotente: usa IF NOT EXISTS, pode rodar varias vezes.
--
-- Uso:
--   docker exec -i aupus-postgres-local psql -U postgres -d aupus_local \
--     -f scripts/db/create-iot-projetos-dev.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS iot_projetos (
  id          CHAR(26)     PRIMARY KEY,
  unidade_id  CHAR(26)     NOT NULL,
  nome        VARCHAR(255) NOT NULL,
  diagrama    JSONB        NOT NULL DEFAULT '{"components":[],"connections":[],"nextId":1}'::jsonb,
  created_at  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP(0)
);

-- FK para unidades — preserva integridade referencial em dev.
-- ON DELETE RESTRICT evita perda silenciosa de projetos quando unidade eh removida.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'iot_projetos_unidade_id_fkey'
  ) THEN
    ALTER TABLE iot_projetos
      ADD CONSTRAINT iot_projetos_unidade_id_fkey
      FOREIGN KEY (unidade_id) REFERENCES unidades(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- Index de lookup principal
CREATE INDEX IF NOT EXISTS idx_iot_projetos_unidade
  ON iot_projetos(unidade_id) WHERE deleted_at IS NULL;
