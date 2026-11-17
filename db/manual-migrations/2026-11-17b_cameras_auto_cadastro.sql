-- NEXON-108 — Câmera nova de fábrica entra sozinha no NexON.
-- O aparelho acha na rede uma câmera Intelbras/Dahua sem senha (inicializada=false): a API cadastra a câmera
-- com uma senha forte gerada (cifrada em cameras.senha) e o aparelho grava essa senha nela.
-- cameras_unidade_config.auto_cadastrar desliga isso por usina. Idempotente. Rollback:
--   ALTER TABLE cameras_unidade_config DROP COLUMN IF EXISTS auto_cadastrar;
BEGIN;
ALTER TABLE cameras_unidade_config ADD COLUMN IF NOT EXISTS auto_cadastrar boolean NOT NULL DEFAULT true;
COMMIT;

-- NEXON-108 — Comandos do aparelho (sem câmera): atualizar, reiniciar, logs. Resultado (ex.: linhas do log) em jsonb.
-- Rollback: ALTER TABLE cameras_comandos DROP COLUMN IF EXISTS resultado;
--           (camera_id volta a NOT NULL só depois de apagar os comandos sem câmera)
BEGIN;
ALTER TABLE cameras_comandos ALTER COLUMN camera_id DROP NOT NULL;
ALTER TABLE cameras_comandos ADD COLUMN IF NOT EXISTS resultado jsonb;
COMMIT;
