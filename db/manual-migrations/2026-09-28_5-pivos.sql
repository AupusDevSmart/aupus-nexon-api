-- ============================================================================
-- AUPU-70 (apps NexON v2) — configuração e programação de pivô.
--
-- pivo_config: uma linha por pivô (equipamento).
--   bloqueio_ponta {ativo, inicio:'18:00', fim:'21:00', dias:[1..5]}
--     ativo → o acionar recusa comandos de PARTIDA (ponto "Ligar"/"Partida";
--     desligar/parar nunca) dentro da janela: 403 COMANDO_BLOQUEADO_PONTA.
--   reservado      {ativo, inicio, fim, dias}  — só guardado (informativo).
--   motobomba_equipamento_id — pivôs com a mesma motobomba formam o "sistema
--     conjugado" (GET /pivos/unidade/:unidadeId/conjugados).
--
-- pivo_programacoes: programações salvas. SÓ ARMAZENADAS — o servidor NÃO
--   executa nada sozinho (não há agendador de comando). Quem liga o pivô é o
--   operador ou o CLP.
--
-- Idempotente. ROLLBACK: DROP TABLE IF EXISTS pivo_programacoes; DROP TABLE IF EXISTS pivo_config;
-- ============================================================================

CREATE TABLE IF NOT EXISTS pivo_config (
  equipamento_id            char(26)   PRIMARY KEY REFERENCES equipamentos(id) ON DELETE CASCADE,
  bloqueio_ponta            jsonb,
  reservado                 jsonb,
  motobomba_equipamento_id  char(26)   REFERENCES equipamentos(id) ON DELETE SET NULL,
  updated_at                timestamp  NOT NULL DEFAULT now(),
  updated_by                char(26)
);

CREATE INDEX IF NOT EXISTS pivo_config_motobomba_idx
  ON pivo_config (motobomba_equipamento_id)
  WHERE motobomba_equipamento_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pivo_programacoes (
  id              char(26)      PRIMARY KEY,
  equipamento_id  char(26)      NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  nome            varchar(120)  NOT NULL,
  ativo           boolean       NOT NULL DEFAULT true,
  hora_inicio     varchar(5)    NOT NULL,              -- 'HH:MM' (America/Sao_Paulo)
  dias            smallint[]    NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  modo            varchar(10)   NOT NULL DEFAULT 'percurso',
  angulo_inicial  numeric(6,2),
  angulo_final    numeric(6,2),
  duracao_min     integer,
  sentido         varchar(12)   NOT NULL DEFAULT 'horario',
  velocidade      numeric(5,2),
  com_agua        boolean       NOT NULL DEFAULT true,
  created_by      char(26),
  updated_by      char(26),
  created_at      timestamp     NOT NULL DEFAULT now(),
  updated_at      timestamp     NOT NULL DEFAULT now(),
  deleted_at      timestamp,
  CONSTRAINT pivo_programacoes_modo_chk    CHECK (modo IN ('percurso', 'tempo')),
  CONSTRAINT pivo_programacoes_sentido_chk CHECK (sentido IN ('horario', 'anti_horario'))
);

CREATE INDEX IF NOT EXISTS pivo_programacoes_equip_idx
  ON pivo_programacoes (equipamento_id)
  WHERE deleted_at IS NULL;
