-- NEXON-88 — Câmeras IP por instalação (unidade): cadastro, agente local (nexon-camera-agent),
-- eventos de detecção (pessoa/veículo/animal/movimento) e de sistema (sem_sinal/sinal_restabelecido/foto),
-- armamento (agenda/manual/desarmado), comandos ao agente (foto) e acionamento de refletor/sirene por
-- ponto de comando de equipamento. Contrato em NexON/docs/cameras/API-CAMERAS.md. Idempotente.
-- Auditoria em auditoria_acessos (acao camera_*). Alarme na tela de alarmes via logs_mqtt (tipo alerta).
--
-- Ids varchar(26) SEM padding (nanoid), como chamados. Sem FK para unidades/plantas/equipamentos/usuarios:
-- essas tabelas são char(26) e o Postgres recusa FK entre varchar e char ("incompatible types");
-- o vínculo é por valor, como nos chamados.
--
-- Rollback:
--   DROP TABLE IF EXISTS cameras_comandos, cameras_eventos, cameras, cameras_agentes, cameras_unidade_config;
BEGIN;

-- Agente local na rede das câmeras. Autentica por token (nxcam_...) que só existe aqui em hash.
CREATE TABLE IF NOT EXISTS cameras_agentes (
  id                 varchar(26) PRIMARY KEY,
  unidade_id         varchar(26) NOT NULL,              -- sem padding (TRIM)
  planta_id          varchar(26) NOT NULL,
  nome               varchar(120) NOT NULL,
  token_hash         varchar(64) NOT NULL UNIQUE,       -- sha256 hex do token em claro
  token_gerado_em    timestamp(0),
  versao             varchar(40),                       -- versão do nexon-camera-agent (heartbeat)
  host               varchar(120),                      -- hostname da máquina do agente (heartbeat)
  ultimo_contato_em  timestamp(0),
  ativo              boolean NOT NULL DEFAULT true,
  created_at         timestamp(0) NOT NULL DEFAULT now(),
  updated_at         timestamp(0) NOT NULL DEFAULT now(),
  deleted_at         timestamp(0)
);
CREATE INDEX IF NOT EXISTS cameras_agentes_unidade_id_idx ON cameras_agentes (unidade_id);

CREATE TABLE IF NOT EXISTS cameras (
  id                    varchar(26) PRIMARY KEY,
  unidade_id            varchar(26) NOT NULL,
  planta_id             varchar(26) NOT NULL,
  agente_id             varchar(26) REFERENCES cameras_agentes (id) ON DELETE SET NULL,
  equipamento_id        varchar(26),                     -- equipamento CFTV: abre chamado e cai em logs_mqtt
  nome                  varchar(120) NOT NULL,
  fabricante            varchar(40) NOT NULL DEFAULT 'intelbras',
  modelo                varchar(80),
  ip                    varchar(64) NOT NULL,
  porta_rtsp            integer NOT NULL DEFAULT 554,
  porta_http            integer NOT NULL DEFAULT 80,
  usuario               varchar(80) NOT NULL,
  senha                 text NOT NULL,                   -- cifrada AES-256-GCM (MIDIA_TOKEN_SECRET || JWT_SECRET)
  canal                 integer NOT NULL DEFAULT 1,
  ativa                 boolean NOT NULL DEFAULT true,
  ordem                 integer NOT NULL DEFAULT 0,
  status                varchar(12) NOT NULL DEFAULT 'desconhecido'
                        CHECK (status IN ('online', 'offline', 'desconhecido')),
  status_em             timestamp(0),
  ultimo_contato_em     timestamp(0),
  miniatura_em          timestamp(0),                    -- arquivo em CAMERAS_STORAGE_DIR/miniaturas/<id>.jpg
  publicando            boolean NOT NULL DEFAULT false,  -- o agente está publicando o vídeo no MediaMTX
  stream_pedido_em      timestamp(0),                    -- último GET /cameras/:id/stream (vale 90 s)
  stream_continuo       boolean NOT NULL DEFAULT false,  -- publica sempre, não só sob demanda
  stream_transcodificar boolean NOT NULL DEFAULT false,  -- câmera em H.265: o agente converte para H.264
  stream_bitrate_kbps   integer NOT NULL DEFAULT 800,
  analise               jsonb NOT NULL DEFAULT '{}'::jsonb, -- ativa, sensibilidade, area_minima_pct, fps_analise, classificar, classes_alerta, clipe_s, zonas
  created_at            timestamp(0) NOT NULL DEFAULT now(),
  updated_at            timestamp(0) NOT NULL DEFAULT now(),
  deleted_at            timestamp(0)
);
CREATE INDEX IF NOT EXISTS cameras_unidade_id_idx ON cameras (unidade_id);
CREATE INDEX IF NOT EXISTS cameras_agente_id_idx  ON cameras (agente_id);

-- Eventos: o que o agente viu. alerta = não lido + notificação; descartado = só estatística
-- ("14 movimentos descartados na noite"), nunca alerta.
CREATE TABLE IF NOT EXISTS cameras_eventos (
  id               varchar(26) PRIMARY KEY,
  camera_id        varchar(26) NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,
  unidade_id       varchar(26) NOT NULL,
  planta_id        varchar(26) NOT NULL,
  tipo             varchar(24) NOT NULL
                   CHECK (tipo IN ('pessoa', 'veiculo', 'animal', 'movimento', 'sem_sinal', 'sinal_restabelecido', 'foto')),
  inicio_em        timestamp(3) NOT NULL,
  fim_em           timestamp(3),
  confianca        numeric(5,4),
  armado           boolean NOT NULL DEFAULT false,
  alerta           boolean NOT NULL DEFAULT false,
  descartado       boolean NOT NULL DEFAULT false,
  motivo_descarte  varchar(24) CHECK (motivo_descarte IS NULL OR motivo_descarte IN ('desarmado', 'classe_ignorada', 'agente')),
  snapshot_path    varchar(255),                        -- relativo a CAMERAS_STORAGE_DIR (eventos/<id>.jpg)
  clipe_path       varchar(255),                        -- eventos/<id>.mp4
  dados            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- caixas, area_pct, duracao_s, quadros...
  lido_em          timestamp(0),
  lido_por_id      varchar(26),
  lido_por_nome    varchar(255),
  chamado_id       varchar(26),
  created_at       timestamp(0) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cameras_eventos_camera_id_inicio_em_idx  ON cameras_eventos (camera_id, inicio_em DESC);
CREATE INDEX IF NOT EXISTS cameras_eventos_unidade_id_inicio_em_idx ON cameras_eventos (unidade_id, inicio_em DESC);
CREATE INDEX IF NOT EXISTS cameras_eventos_unidade_id_alerta_lido_em_idx ON cameras_eventos (unidade_id, alerta, lido_em);

-- Configuração por instalação. Sem linha = agenda 18:00–06:30 (hora de Brasília), sem refletor/sirene.
CREATE TABLE IF NOT EXISTS cameras_unidade_config (
  unidade_id              varchar(26) PRIMARY KEY,
  planta_id               varchar(26) NOT NULL,
  armamento_modo          varchar(12) NOT NULL DEFAULT 'agenda'
                          CHECK (armamento_modo IN ('agenda', 'manual', 'desarmado')),
  armado_manual           boolean NOT NULL DEFAULT false,
  armado_manual_ate       timestamp(0),                   -- nulo = até alguém desarmar
  agenda_inicio           time(0) DEFAULT '18:00',
  agenda_fim              time(0) DEFAULT '06:30',
  refletor_equipamento_id varchar(26),                    -- ponto de comando que pulsa o refletor
  refletor_ponto_id       varchar(26),
  sirene_equipamento_id   varchar(26),
  sirene_ponto_id         varchar(26),
  abrir_chamado           boolean NOT NULL DEFAULT false, -- alerta abre chamado no equipamento da câmera
  notificar_emails        text[] NOT NULL DEFAULT '{}',
  updated_at              timestamp(0) NOT NULL DEFAULT now(),
  updated_por_id          varchar(26)
);

-- Pedidos da pessoa ao agente (foto agora). O agente busca os pendentes e devolve o resultado.
CREATE TABLE IF NOT EXISTS cameras_comandos (
  id                varchar(26) PRIMARY KEY,
  camera_id         varchar(26) NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,
  agente_id         varchar(26) NOT NULL REFERENCES cameras_agentes (id) ON DELETE CASCADE,
  tipo              varchar(24) NOT NULL,                 -- foto
  parametros        jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado            varchar(12) NOT NULL DEFAULT 'pendente'
                    CHECK (estado IN ('pendente', 'entregue', 'ok', 'erro')),
  erro              varchar(500),
  evento_id         varchar(26),                          -- evento `foto` gerado pelo agente
  solicitado_por_id varchar(26),
  created_at        timestamp(0) NOT NULL DEFAULT now(),
  entregue_em       timestamp(0),
  concluido_em      timestamp(0)
);
CREATE INDEX IF NOT EXISTS cameras_comandos_agente_id_estado_idx ON cameras_comandos (agente_id, estado);

COMMIT;
