-- ============================================================================
-- Fase 7 / arqIoT — VÍNCULO unificado (ponto lógico ↔ canal físico).
--
-- Hoje o vínculo mora em QUATRO lugares: ton_bo, ton_bi, ton_ai (tabelas) e
-- iot_componentes.props.io_config (JSON dentro do diagrama). Isso obriga:
--   - varredura jsonb (resolveReleBo, statusFonteDoDisjuntor);
--   - inferência de papel por REGEX na chave (campo_aberto/campo_fechado);
--   - escrita do diagrama INTEIRO pra mudar um vínculo;
--   - FK impossível pro nó (syncRelational apaga e recria iot_componentes).
--
-- Esta tabela unifica os quatro. Referência estável: SEMPRE por equipamento
-- (nunca por componente do diagrama, que é destruído/recriado a cada save).
--
-- FASE 1: apenas cria. Ninguém lê nem escreve ainda — mudança de comportamento
-- é ZERO. As fases seguintes fazem backfill, dual-write, sombra e flip.
--
-- ROLLBACK: DROP TABLE IF EXISTS iot_vinculos;
-- ============================================================================

CREATE TABLE IF NOT EXISTS iot_vinculos (
  id                    char(26)     PRIMARY KEY,

  -- O ponto lógico do elemento do unifilar (Abrir, Fechado, Nível...).
  equipamento_ponto_id  char(26)     NOT NULL
                                     REFERENCES equipamento_pontos(id) ON DELETE CASCADE,

  -- De onde o dado vem.
  --   ton_bo    = saída digital da TON (comando)
  --   ton_bi    = entrada digital da TON (status)
  --   ton_ai    = entrada analógica da TON (medição)
  --   modbus_bo = coil/registrador de um device Modbus (comando)
  --   modbus_bi = bit de um device Modbus (status)
  --   modbus_ai = grandeza de um device Modbus (medição)  [hoje sem store; nasce aqui]
  fonte_tipo            varchar(16)  NOT NULL,

  -- Dono do canal: a TON (ton_*) ou o device Modbus (modbus_*), SEMPRE como
  -- equipamento — é o id estável, ao contrário do componente do diagrama.
  fonte_equipamento_id  char(26)     NOT NULL
                                     REFERENCES equipamentos(id) ON DELETE CASCADE,

  -- Número do canal físico (BO1..8 / BI1..8 / AI1..4). Só para fonte ton_*.
  canal                 integer,

  -- Identificador do sinal no catálogo do device (ex.: 'dj_aberto', 'cb1_abre').
  -- Só para fonte modbus_*.
  sinal                 varchar(64),

  -- Papel semântico do ponto na leitura (ex.: 'aberto', 'fechado'). Substitui a
  -- inferência por regex sobre as chaves do io_config.
  papel                 varchar(24),

  -- Parâmetros específicos da fonte, sem inventar coluna para cada uma:
  --   ton_bo    {"pulso_ms":500}
  --   ton_bi    {"invertido":false}
  --   ton_ai    {"mv_0":0,"mv_100":3000}
  --   modbus_bo {"coil":564,"func":5,"addr":12,"count":2,"value":1,"hold":false,"bo_id":"..."}
  params                jsonb        NOT NULL DEFAULT '{}'::jsonb,

  ativo                 boolean      NOT NULL DEFAULT true,

  -- Auditoria da migração: de qual store esta linha nasceu.
  origem                varchar(16)  NOT NULL DEFAULT 'app',

  created_at            timestamp    NOT NULL DEFAULT now(),
  updated_at            timestamp    NOT NULL DEFAULT now(),
  deleted_at            timestamp,

  CONSTRAINT iot_vinculos_fonte_tipo_chk CHECK (
    fonte_tipo IN ('ton_bo','ton_bi','ton_ai','modbus_bo','modbus_bi','modbus_ai')
  ),
  -- Canal é obrigatório na TON e inexistente no Modbus (que usa `sinal`).
  CONSTRAINT iot_vinculos_canal_chk CHECK (
    (fonte_tipo LIKE 'ton_%'    AND canal IS NOT NULL) OR
    (fonte_tipo LIKE 'modbus_%' AND canal IS NULL)
  )
);

-- Um canal físico da TON serve no máximo um ponto.
CREATE UNIQUE INDEX IF NOT EXISTS iot_vinculos_canal_uniq
  ON iot_vinculos (fonte_equipamento_id, fonte_tipo, canal)
  WHERE canal IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS iot_vinculos_ponto_idx
  ON iot_vinculos (equipamento_ponto_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS iot_vinculos_fonte_idx
  ON iot_vinculos (fonte_equipamento_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE iot_vinculos IS
  'arqIoT: vínculo ponto lógico (equipamento_pontos) ↔ canal físico (TON BO/BI/AI ou sinal Modbus). Unifica ton_bo/ton_bi/ton_ai/io_config.';
