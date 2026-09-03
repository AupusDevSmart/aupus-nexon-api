-- CSMS OCPP 1.6-J: estações, transações (sessões) e leituras. Ver docs futuros.
CREATE SEQUENCE IF NOT EXISTS ocpp_transaction_seq START 1;

CREATE TABLE IF NOT EXISTS ocpp_charge_points (
  id                char(26) PRIMARY KEY,
  charge_point_id   varchar(64) NOT NULL UNIQUE,   -- identidade OCPP (path do WS)
  vendor            varchar(80),
  model             varchar(80),
  firmware_version  varchar(80),
  serial_number     varchar(80),
  ocpp_version      varchar(16) DEFAULT '1.6',
  status            varchar(24),                    -- último StatusNotification
  conectado         boolean NOT NULL DEFAULT false,
  ultimo_boot       timestamp,
  ultimo_heartbeat  timestamp,
  planta_id         char(26),
  equipamento_id    char(26),
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ocpp_transactions (
  id                char(26) PRIMARY KEY,
  transaction_id    bigint NOT NULL,
  charge_point_id   varchar(64) NOT NULL,
  connector_id      int,
  id_tag            varchar(64),
  morador_id        char(26),
  meter_start       integer,     -- Wh
  meter_stop        integer,     -- Wh
  energia_kwh       numeric,
  inicio            timestamp,
  fim               timestamp,
  motivo_fim        varchar(32),
  status            varchar(16) NOT NULL DEFAULT 'ativa',  -- ativa|encerrada
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ocpp_tx ON ocpp_transactions (transaction_id);
CREATE INDEX IF NOT EXISTS ix_ocpp_tx_cp ON ocpp_transactions (charge_point_id);

CREATE TABLE IF NOT EXISTS ocpp_meter_values (
  id                char(26) PRIMARY KEY,
  transaction_id    bigint,
  charge_point_id   varchar(64) NOT NULL,
  connector_id      int,
  ts                timestamp,
  energia_wh        numeric,
  potencia_w        numeric,
  raw               jsonb,
  created_at        timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ocpp_mv_tx ON ocpp_meter_values (transaction_id);
