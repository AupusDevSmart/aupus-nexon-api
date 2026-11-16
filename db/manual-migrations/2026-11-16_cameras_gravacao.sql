-- NEXON-108 — Histórico gravado no aparelho (Raspberry com o nexon-camera-agent).
-- O agente grava a câmera em disco local por N dias (padrão 7) e, a pedido, corta um trecho e envia
-- (comando `trecho`, arquivo em CAMERAS_STORAGE_DIR/trechos/<comando_id>.mp4, apagado em 24 h).
--
-- cameras.gravacao (jsonb):
--   config: { ativa: bool, dias: 1..30, stream: 'secundario' | 'principal' }  -- vai ao agente no GET config
--   status: { ativa: bool, de?: ISO, ate?: ISO, uso_gb?: num, livre_gb?: num, em: ISO } -- último heartbeat
-- Idempotente. Rollback:
--   ALTER TABLE cameras DROP COLUMN IF EXISTS gravacao;
BEGIN;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS gravacao jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
