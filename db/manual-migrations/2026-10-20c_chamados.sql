-- NEXON-24 — Chamados: quem opera pede reparo de um equipamento; o NexON registra e encaminha
-- (Smart Service, WhatsApp ou e-mail do proprietário). O NexON NÃO gera ordem de serviço.
-- Auditoria em auditoria_acessos (acao chamado_*). Idempotente.
-- Rollback:
--   DROP TABLE IF EXISTS chamados_encaminhamentos, chamados;
BEGIN;

CREATE TABLE IF NOT EXISTS chamados (
  id                varchar(26) PRIMARY KEY,
  numero            serial UNIQUE,                     -- referência humana: "Chamado #123"
  equipamento_id    varchar(26) NOT NULL,              -- sem padding (TRIM)
  unidade_id        varchar(26),
  planta_id         varchar(26),
  proprietario_id   varchar(26),
  titulo            varchar(200) NOT NULL,
  descricao         text NOT NULL,
  motivo            varchar(20) NOT NULL DEFAULT 'FALHA'
                    CHECK (motivo IN ('FALHA', 'ALARME', 'CAMPO', 'OUTRO')),
  prioridade        varchar(10) NOT NULL DEFAULT 'MEDIA'
                    CHECK (prioridade IN ('BAIXA', 'MEDIA', 'ALTA', 'URGENTE')),
  status            varchar(12) NOT NULL DEFAULT 'ABERTO'
                    CHECK (status IN ('ABERTO', 'ENCAMINHADO', 'FECHADO')),
  canal             varchar(10) NOT NULL DEFAULT 'WEB' CHECK (canal IN ('WEB', 'APP')),
  autor_id          varchar(26),
  autor_nome        varchar(255),
  fechado_em        timestamp(0),
  fechado_por_id    varchar(26),
  fechado_por_nome  varchar(255),
  motivo_fechamento varchar(500),
  created_at        timestamp(0) NOT NULL DEFAULT now(),
  updated_at        timestamp(0) NOT NULL DEFAULT now(),
  deleted_at        timestamp(0)
);
CREATE INDEX IF NOT EXISTS chamados_status_idx      ON chamados (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS chamados_planta_idx      ON chamados (planta_id);
CREATE INDEX IF NOT EXISTS chamados_equipamento_idx ON chamados (equipamento_id);
CREATE INDEX IF NOT EXISTS chamados_created_idx     ON chamados (created_at DESC);

-- Fila de encaminhamento. Um worker (ChamadosEncaminhamentoWorker) envia o que está PENDENTE;
-- SMART_SERVICE sem integração configurada fica AGUARDANDO_INTEGRACAO e sai sozinho quando
-- SMART_SERVICE_URL/SMART_SERVICE_TOKEN existirem.
CREATE TABLE IF NOT EXISTS chamados_encaminhamentos (
  id            varchar(26) PRIMARY KEY,
  chamado_id    varchar(26) NOT NULL REFERENCES chamados (id) ON DELETE CASCADE,
  destino       varchar(15) NOT NULL CHECK (destino IN ('SMART_SERVICE', 'WHATSAPP', 'EMAIL')),
  contato       varchar(255),                          -- telefone ou e-mail; nulo no Smart Service
  observacao    varchar(1000),
  status        varchar(25) NOT NULL DEFAULT 'PENDENTE'
                CHECK (status IN ('PENDENTE', 'AGUARDANDO_INTEGRACAO', 'ENVIADO', 'FALHOU')),
  tentativas    integer NOT NULL DEFAULT 0,
  ultimo_erro   varchar(500),
  referencia_externa varchar(100),                     -- id devolvido pelo destino (ex.: solicitação no Service)
  enviado_em    timestamp(0),
  autor_id      varchar(26),
  autor_nome    varchar(255),
  created_at    timestamp(0) NOT NULL DEFAULT now(),
  updated_at    timestamp(0) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chamados_encaminhamentos_fila_idx
  ON chamados_encaminhamentos (status, created_at) WHERE status IN ('PENDENTE', 'AGUARDANDO_INTEGRACAO');
CREATE INDEX IF NOT EXISTS chamados_encaminhamentos_chamado_idx ON chamados_encaminhamentos (chamado_id);

COMMIT;
