-- NEXON-108 — Pareamento do aparelho (Raspberry com o nexon-camera-agent) por código de 6 dígitos e
-- câmeras encontradas na rede local pelo agente (descoberta Dahua/Intelbras UDP 37810 + ONVIF).
-- Objetivo: instalar câmera sem copiar token à mão e sem digitar IP. Idempotente.
--
-- Pareamento: o aparelho sem token pede um código (POST /cameras/pareamento, público), a pessoa
-- logada digita o código (POST /cameras/pareamento/vincular), a API cria o agente e guarda o token
-- cifrado (AES-256-GCM, mesma cifra da senha da câmera) até o aparelho buscar UMA vez
-- (POST /cameras/pareamento/:id/estado); na entrega token_cifrado é apagado.
--
-- Ids varchar(26) sem padding (nanoid), como cameras_agentes.
--
-- Rollback:
--   DROP TABLE IF EXISTS cameras_descobertas, cameras_pareamentos;
BEGIN;

CREATE TABLE IF NOT EXISTS cameras_pareamentos (
  id             varchar(26) PRIMARY KEY,
  codigo         varchar(6) NOT NULL,                    -- 6 dígitos, único entre os pedidos não expirados
  segredo_hash   varchar(64) NOT NULL,                   -- sha256 hex do segredo devolvido só na criação
  host           varchar(120) NOT NULL,
  mac            varchar(17),
  versao         varchar(40),
  ip_publico     varchar(64) NOT NULL,                   -- IP de quem pediu (req.ip, trust proxy)
  ip_local       varchar(64),
  criado_em      timestamp(0) NOT NULL DEFAULT now(),
  expira_em      timestamp(0) NOT NULL,                  -- criado_em + 30 min
  agente_id      varchar(26) REFERENCES cameras_agentes (id) ON DELETE SET NULL,
  token_cifrado  text,                                   -- AES-256-GCM; apagado na entrega
  vinculado_em   timestamp(0),
  entregue_em    timestamp(0)
);
CREATE INDEX IF NOT EXISTS cameras_pareamentos_codigo_expira_em_idx ON cameras_pareamentos (codigo, expira_em);
CREATE INDEX IF NOT EXISTS cameras_pareamentos_ip_publico_expira_em_idx ON cameras_pareamentos (ip_publico, expira_em);

-- Câmeras que o agente encontrou na rede (heartbeat `descobertas`). Upsert por (agente_id, ip);
-- as não vistas há mais de 1 dia são apagadas.
CREATE TABLE IF NOT EXISTS cameras_descobertas (
  id            varchar(26) PRIMARY KEY,
  agente_id     varchar(26) NOT NULL REFERENCES cameras_agentes (id) ON DELETE CASCADE,
  ip            varchar(64) NOT NULL,
  mac           varchar(17),
  fabricante    varchar(40),                             -- minúsculas: intelbras, hikvision, onvif
  modelo        varchar(80),
  serial        varchar(80),
  porta_http    integer,
  porta_rtsp    integer,
  inicializada  boolean,
  visto_em      timestamp(0) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cameras_descobertas_agente_id_ip_key ON cameras_descobertas (agente_id, ip);
CREATE INDEX IF NOT EXISTS cameras_descobertas_visto_em_idx ON cameras_descobertas (visto_em);

COMMIT;
