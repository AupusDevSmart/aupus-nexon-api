-- Controle automático pelo MED Concessionária (SSU): cadastro, histórico e ciclos.
-- docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md (decisões R1–R12 em
-- docs/IOT-CONTROLE-MED-CONCESSIONARIA-DIVERGENCIAS.md §6).
--   controle_med_config      : 1 linha por MED (params, UFVs/inversores, modo de cada controle)
--   controle_med_config_hist : cada alteração (versão anterior + quem + quando)
--   controle_med_ciclos      : 1 linha por minuto do medidor (entradas, portão, pedidos, comandos)
-- Nada atua com a migração: todo controle nasce "desligado".
-- Idempotente.
BEGIN;

CREATE TABLE IF NOT EXISTS controle_med_config (
  med_id       char(26) PRIMARY KEY REFERENCES equipamentos(id) ON DELETE CASCADE,
  params       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  ufvs         jsonb     NOT NULL DEFAULT '[]'::jsonb,
  modos        jsonb     NOT NULL DEFAULT '{"fp":"desligado","demanda_g":"desligado","demanda_c":"desligado"}'::jsonb,
  versao       integer   NOT NULL DEFAULT 1,
  updated_by   char(26),
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS controle_med_config_hist (
  id           bigserial PRIMARY KEY,
  med_id       char(26)  NOT NULL,
  versao       integer   NOT NULL,
  o_que        varchar(20) NOT NULL,          -- 'config' | 'modos'
  params       jsonb,
  ufvs         jsonb,
  modos        jsonb,
  resumo       text,
  alterado_por char(26),
  alterado_em  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_controle_med_hist_med ON controle_med_config_hist (med_id, alterado_em DESC);

CREATE TABLE IF NOT EXISTS controle_med_ciclos (
  id         bigserial PRIMARY KEY,
  med_id     char(26)  NOT NULL,
  ts         timestamp NOT NULL,                -- hora do minuto (TON/gateway)
  nsu        integer,
  seg        integer,
  entradas   jsonb,                             -- projeções, P/Q, acumulados, inversores
  portao     jsonb,                             -- portão de qualidade (ok + motivos)
  pedidos    jsonb,                             -- o que cada controle pediu
  comandos   jsonb,                             -- por inversor: o que enviou / enviaria
  modos      jsonb,                             -- modo de cada controle neste ciclo
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_controle_med_ciclos_med_ts ON controle_med_ciclos (med_id, ts DESC);

COMMIT;
