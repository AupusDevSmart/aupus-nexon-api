-- NEXON-130 — carregador de veículo elétrico por OCPP 1.6J (Chint Wallbox) ligado ao
-- carregador do condomínio: vínculo estação ↔ equipamento com chave de conexão, estado e
-- falha por conector, última leitura, limites de uso (tempo, energia, corrente), início
-- automático e o elo recarga ↔ transação OCPP.
-- Idempotente. Rodar ANTES do deploy da API (o deploy não roda SQL manual).
-- ROLLBACK:
--   DROP INDEX IF EXISTS uq_ocpp_cp_equipamento, uq_ocpp_cp_chave, ix_carregador_sessoes_ocpp_tx, ix_ocpp_mv_cp_ts;
--   ALTER TABLE ocpp_charge_points DROP COLUMN chave_hash, DROP COLUMN chave_gerada_em, DROP COLUMN connector_id,
--     DROP COLUMN error_code, DROP COLUMN vendor_error_code, DROP COLUMN info, DROP COLUMN status_em, DROP COLUMN falha_desde,
--     DROP COLUMN perfis, DROP COLUMN ultima_conexao, DROP COLUMN ultima_desconexao, DROP COLUMN ip, DROP COLUMN disponivel,
--     DROP COLUMN leitura, DROP COLUMN leitura_em, DROP COLUMN deleted_at;
--   ALTER TABLE carregador_config DROP COLUMN limite_corrente_a, DROP COLUMN corrente_max_a, DROP COLUMN corrente_suportada,
--     DROP COLUMN limite_tempo_min, DROP COLUMN limite_energia_kwh, DROP COLUMN inicio_automatico;
--   ALTER TABLE carregador_sessoes DROP COLUMN ocpp_transaction_id, DROP COLUMN ocpp_id_tag, DROP COLUMN limite_tempo_min,
--     DROP COLUMN limite_energia_kwh, DROP COLUMN motivo_fim, DROP COLUMN parada_pedida_em;
--   ALTER TABLE ocpp_meter_values DROP COLUMN corrente_a, DROP COLUMN tensao_v, DROP COLUMN temperatura_c, DROP COLUMN soc;
BEGIN;

-- Estação OCPP: a chave de conexão (só o hash), o conector que é este equipamento, o estado
-- e a falha do último StatusNotification, a última leitura e o que o carregador declara suportar.
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS chave_hash         varchar(64);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS chave_gerada_em    timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS connector_id       integer NOT NULL DEFAULT 1;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS error_code         varchar(40);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS vendor_error_code  varchar(60);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS info               varchar(120);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS status_em          timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS falha_desde        timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS perfis             varchar(255);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS ultima_conexao     timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS ultima_desconexao  timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS ip                 varchar(64);
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS disponivel         boolean NOT NULL DEFAULT true;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS leitura            jsonb;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS leitura_em         timestamp(0) without time zone;
ALTER TABLE ocpp_charge_points ADD COLUMN IF NOT EXISTS deleted_at         timestamp(0) without time zone;

-- Um carregador (equipamento) tem no máximo uma estação ativa; a chave não se repete.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ocpp_cp_equipamento ON ocpp_charge_points (equipamento_id)
  WHERE equipamento_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ocpp_cp_chave ON ocpp_charge_points (chave_hash)
  WHERE chave_hash IS NOT NULL AND deleted_at IS NULL;

-- Limites de uso do carregador (padrão de cada recarga) e a corrente máxima aplicada.
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS limite_corrente_a   numeric(5,1);
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS corrente_max_a      numeric(5,1);
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS corrente_suportada  boolean;
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS limite_tempo_min    integer;
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS limite_energia_kwh  numeric(8,2);
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS inicio_automatico   boolean NOT NULL DEFAULT false;

-- Recarga: a transação OCPP que a mede, a tag que a identifica no carregador, os limites
-- valendo para ela e por que terminou.
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS ocpp_transaction_id bigint;
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS ocpp_id_tag         varchar(20);
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS limite_tempo_min    integer;
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS limite_energia_kwh  numeric(8,2);
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS motivo_fim          varchar(24);
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS parada_pedida_em    timestamp(0) without time zone;
CREATE INDEX IF NOT EXISTS ix_carregador_sessoes_ocpp_tx ON carregador_sessoes (ocpp_transaction_id)
  WHERE ocpp_transaction_id IS NOT NULL;

-- Leituras: as grandezas além de energia e potência (o payload inteiro segue em `raw`).
ALTER TABLE ocpp_meter_values ADD COLUMN IF NOT EXISTS corrente_a     numeric;
ALTER TABLE ocpp_meter_values ADD COLUMN IF NOT EXISTS tensao_v       numeric;
ALTER TABLE ocpp_meter_values ADD COLUMN IF NOT EXISTS temperatura_c  numeric;
ALTER TABLE ocpp_meter_values ADD COLUMN IF NOT EXISTS soc            numeric;
CREATE INDEX IF NOT EXISTS ix_ocpp_mv_cp_ts ON ocpp_meter_values (charge_point_id, ts DESC);

COMMIT;
