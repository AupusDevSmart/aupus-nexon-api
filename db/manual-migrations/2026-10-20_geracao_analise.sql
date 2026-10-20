-- NEXON-16 — Análise de geração (esperado, perdas, fechamento do mês, previsão).
-- Ver docs/GERACAO-ANALISE.md. Idempotente.
-- Rollback:
--   DROP TABLE IF EXISTS geracao_jobs_execucao, geracao_analise_diaria, geracao_limitacao_eventos, irradiancia_15min,
--                        unidade_usina_config_historico, unidade_usina_config;
BEGIN;

-- Grupo "Usina" da configuração da instalação (GER-5, seção 7). unidade_id sem padding (TRIM).
CREATE TABLE IF NOT EXISTS unidade_usina_config (
  unidade_id                 varchar(26) PRIMARY KEY,
  fonte_irradiancia          varchar(20) NOT NULL DEFAULT 'nenhuma'
                             CHECK (fonte_irradiancia IN ('satelite', 'solarimetro', 'nenhuma')),
  solarimetro_equipamento_id varchar(26),
  solarimetro_medicao        varchar(3) CHECK (solarimetro_medicao IN ('GHI', 'POA')),
  kwp_dc                     numeric(12, 3),
  potencia_ac_kw             numeric(12, 3),          -- null = soma das potências dos inversores
  inclinacao_graus           numeric(5, 2),
  azimute_graus              numeric(5, 2),           -- 0 = norte, sentido horário
  fator_desempenho           numeric(4, 3) NOT NULL DEFAULT 0.800,
  exibir_rs                  boolean NOT NULL DEFAULT false,
  tarifa_concessionaria_id   varchar(26),
  updated_by                 varchar(26),
  created_at                 timestamp(0) NOT NULL DEFAULT now(),
  updated_at                 timestamp(0) NOT NULL DEFAULT now()
);

-- Trilha de auditoria da config: uma linha por gravação, campo a campo (antigo → novo).
CREATE TABLE IF NOT EXISTS unidade_usina_config_historico (
  id          bigserial PRIMARY KEY,
  unidade_id  varchar(26) NOT NULL,
  usuario_id  varchar(26),
  usuario_nome varchar(255),
  usuario_papel varchar(40),
  campos      text[] NOT NULL,                        -- facilita filtrar "quem mexeu no fator"
  alteracoes  jsonb NOT NULL,                          -- { campo: { de, para } }
  resumo      varchar(500) NOT NULL,
  created_at  timestamp(0) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usina_cfg_hist_unidade ON unidade_usina_config_historico (unidade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usina_cfg_hist_usuario ON unidade_usina_config_historico (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usina_cfg_hist_campos ON unidade_usina_config_historico USING gin (campos);

-- Irradiância no plano dos módulos (W/m²), 15 min. ts = INÍCIO do intervalo, em UTC.
-- tipo: observado (satélite/solarímetro) | previsto (API de clima).
CREATE TABLE IF NOT EXISTS irradiancia_15min (
  unidade_id  varchar(26) NOT NULL,
  tipo        varchar(10) NOT NULL CHECK (tipo IN ('observado', 'previsto')),
  ts          timestamp(0) NOT NULL,
  g_poa_wm2   numeric(8, 2) NOT NULL,
  fonte       varchar(20) NOT NULL,                    -- satelite | solarimetro
  provedor    varchar(30) NOT NULL,                    -- open-meteo | equipamento
  updated_at  timestamp(0) NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, tipo, ts)
);

-- Cache do resumo diário (dias completos). Mudar a config apaga as linhas da unidade.
CREATE TABLE IF NOT EXISTS geracao_analise_diaria (
  unidade_id            varchar(26) NOT NULL,
  dia                   date NOT NULL,
  real_kwh              numeric(14, 3),               -- null = sem dados
  esperado_kwh          numeric(14, 3),               -- null = sem irradiância/sem fonte
  real_com_esperado_kwh numeric(14, 3),               -- real só nos intervalos que têm esperado
  indisponibilidade_kwh numeric(14, 3) NOT NULL DEFAULT 0,
  limitacao_projeto_kwh numeric(14, 3) NOT NULL DEFAULT 0,
  limitacao_externa_kwh numeric(14, 3) NOT NULL DEFAULT 0,
  intervalos_com_dado   int NOT NULL DEFAULT 0,
  fonte                 varchar(20) NOT NULL,
  calculado_em          timestamp(0) NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, dia)
);

-- Idempotência do evento "Limitação externa" no Registro (GER-18).
CREATE TABLE IF NOT EXISTS geracao_limitacao_eventos (
  unidade_id  varchar(26) NOT NULL,
  inicio      timestamp(0) NOT NULL,                   -- UTC
  fim         timestamp(0) NOT NULL,
  kwh         numeric(14, 3) NOT NULL,
  log_id      varchar(26),
  created_at  timestamp(0) NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, inicio)
);

-- Cache invalidado por conteúdo: hash da config e geometria dos módulos (revisão NEXON-16).
ALTER TABLE geracao_analise_diaria ADD COLUMN IF NOT EXISTS config_hash varchar(40);
ALTER TABLE geracao_analise_diaria ADD COLUMN IF NOT EXISTS intervalos_com_esperado int NOT NULL DEFAULT 0;
ALTER TABLE irradiancia_15min ADD COLUMN IF NOT EXISTS geometria varchar(20);

-- Uma execução por job e horário mesmo com várias instâncias da API (claim por INSERT).
CREATE TABLE IF NOT EXISTS geracao_jobs_execucao (
  job         varchar(40) NOT NULL,
  slot        varchar(20) NOT NULL,                    -- ex.: 2026-10-20T06
  created_at  timestamp(0) NOT NULL DEFAULT now(),
  PRIMARY KEY (job, slot)
);

COMMIT;
