-- NEXON-108 — Vínculo automático do Raspberry instalado pelo computador.
-- O instalador grava no SD uma chave assinada da usina (uso único, 7 dias). O aparelho manda a chave no
-- pedido de pareamento e a API vincula sozinha; vinculo_nonce garante uso único. Idempotente. Rollback:
--   ALTER TABLE cameras_pareamentos DROP COLUMN IF EXISTS vinculo_nonce;
BEGIN;
ALTER TABLE cameras_pareamentos ADD COLUMN IF NOT EXISTS vinculo_nonce varchar(32);
CREATE UNIQUE INDEX IF NOT EXISTS cameras_pareamentos_vinculo_nonce_key ON cameras_pareamentos (vinculo_nonce);
COMMIT;
