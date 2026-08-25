-- ============================================================================
-- Carregador Elétrico (EV) — recarga por morador em condomínio.
-- Data: 2026-08-20
-- Espelha o padrão bomba-combustível. SQL manual (schema.prisma vive no pacote
-- git api-shared; acesso via $queryRaw/$executeRaw). prisma migrate deploy não
-- dropa tabelas fora do schema → seguras.
-- ============================================================================

-- Moradores autorizados do condomínio (entidade própria, NÃO é usuário de login).
CREATE TABLE IF NOT EXISTS moradores (
  id          char(26) PRIMARY KEY,
  planta_id   char(26),
  unidade_id  char(26),
  nome        varchar(120) NOT NULL,
  apartamento varchar(40),
  tag_uid     varchar(32),                 -- opcional (modo automático por tag)
  ativo       boolean NOT NULL DEFAULT true,
  created_at  timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at  timestamp(0) without time zone NOT NULL DEFAULT now(),
  deleted_at  timestamp(0) without time zone
);
CREATE INDEX IF NOT EXISTS idx_moradores_planta ON moradores(planta_id);
CREATE INDEX IF NOT EXISTS idx_moradores_tag    ON moradores(tag_uid);

-- Config por carregador (vaga).
CREATE TABLE IF NOT EXISTS carregador_config (
  id                 char(26) PRIMARY KEY,
  equipamento_id     char(26) NOT NULL,
  fonte_kwh          varchar(12) NOT NULL DEFAULT 'ton',   -- 'ton' | 'carregador'
  tarifa_kwh         numeric,                              -- R$/kWh (rateio)
  potencia_kw        numeric,
  topico_energia     text,                                 -- tópico MQTT do kWh acumulado
  ultimo_estado      varchar(16),
  ultima_leitura_kwh numeric,
  ultima_leitura     timestamp(0) without time zone,
  created_at         timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at         timestamp(0) without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carregador_config_eq ON carregador_config(equipamento_id);

-- Sessões de recarga (com energia + ociosidade).
CREATE TABLE IF NOT EXISTS carregador_sessoes (
  id                    char(26) PRIMARY KEY,
  equipamento_id        char(26) NOT NULL,
  planta_id             char(26),
  morador_id            char(26),
  morador_nome          varchar(120),
  inicio                timestamp(0) without time zone NOT NULL DEFAULT now(),
  fim                   timestamp(0) without time zone,
  kwh_inicio            numeric,
  kwh_fim               numeric,
  kwh_total             numeric,
  liberado_por          varchar(16) NOT NULL DEFAULT 'porteiro', -- 'tag' | 'porteiro'
  liberado_por_user     varchar(120),
  ocioso_inicio         timestamp(0) without time zone,          -- setado quando outro pede a vaga
  ocioso_por_morador_id char(26),
  ocioso_por_nome       varchar(120),
  ocioso_min            integer,
  status                varchar(12) NOT NULL DEFAULT 'ativa',    -- 'ativa' | 'encerrada'
  created_at            timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at            timestamp(0) without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carregador_sessoes_eq      ON carregador_sessoes(equipamento_id);
CREATE INDEX IF NOT EXISTS idx_carregador_sessoes_status  ON carregador_sessoes(status);
CREATE INDEX IF NOT EXISTS idx_carregador_sessoes_morador ON carregador_sessoes(morador_id);

-- Log de "pedir a vaga" (quem pediu e quando → marca início do ocioso).
CREATE TABLE IF NOT EXISTS carregador_pedidos_vaga (
  id             char(26) PRIMARY KEY,
  equipamento_id char(26) NOT NULL,
  sessao_id      char(26),
  morador_id     char(26),
  morador_nome   varchar(120),
  quando         timestamp(0) without time zone NOT NULL DEFAULT now(),
  created_at     timestamp(0) without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_vaga_eq ON carregador_pedidos_vaga(equipamento_id);

-- Catálogo IoT: pontos de IO do carregador (bo Habilitar/Desabilitar, bi Conectado).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM iot_device_tipos WHERE codigo='carregador_eletrico') THEN
    INSERT INTO iot_device_tipos (id, codigo, nome, pontos)
    VALUES ('carregadoreletrico00000000', 'carregador_eletrico', 'Carregador Elétrico',
      '{"bo":[{"id":"habilitar","label":"Habilitar"},{"id":"desabilitar","label":"Desabilitar"}],"bi":[{"id":"conectado","label":"Conectado"}],"ai":[]}'::jsonb);
  ELSE
    UPDATE iot_device_tipos SET
      nome='Carregador Elétrico',
      pontos='{"bo":[{"id":"habilitar","label":"Habilitar"},{"id":"desabilitar","label":"Desabilitar"}],"bi":[{"id":"conectado","label":"Conectado"}],"ai":[]}'::jsonb,
      updated_at=now()
    WHERE codigo='carregador_eletrico';
  END IF;
END $$;
