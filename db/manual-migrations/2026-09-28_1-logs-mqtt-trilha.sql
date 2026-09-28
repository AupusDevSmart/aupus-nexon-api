-- ============================================================================
-- AUPU-70 (apps NexON v2) — trilha de alarmes e comandos em logs_mqtt
-- + tabela de auditoria de ACESSO (mudança de permissão de operador).
--
-- logs_mqtt ganha (todas nullable, aditivas):
--   reconhecido_em / reconhecido_por   já existiam em PRODUÇÃO criadas à mão (o
--                                      reconhecer() e o COA usam) — aqui só
--                                      garantimos (IF NOT EXISTS) para o dev.
--   reconhecido_por_id                 quem reconheceu (usuarios.id); o antigo
--                                      reconhecido_por é o NOME em texto e fica.
--   resolvido_em / resolvido_por       POST /logs-mqtt/:id/resolver
--   silenciado_ate                     POST /logs-mqtt/:id/silenciar {horas}
--   dispositivo                        "iPhone 15 Pro · iOS" / "Chrome no Windows"
--                                      (headers X-Client-*) — trilha de comando
--
-- Colunas continuam FORA do schema Prisma (acesso por $queryRaw), como as de
-- reconhecimento: se este SQL não rodar antes do deploy, só as rotas novas
-- quebram — a ingestão de alarmes (logs_mqtt.create) segue igual.
--
-- auditoria_acessos: "acesso" do GET /logs-mqtt?tipo=acesso. logs_mqtt.equipamento_id
-- é NOT NULL + FK (e o Prisma o declara obrigatório), então mudança de permissão
-- — que não tem equipamento — mora aqui e é mesclada na listagem.
--
-- Idempotente. ROLLBACK:
--   ALTER TABLE logs_mqtt DROP COLUMN IF EXISTS reconhecido_por_id, DROP COLUMN IF EXISTS resolvido_em,
--     DROP COLUMN IF EXISTS resolvido_por, DROP COLUMN IF EXISTS silenciado_ate, DROP COLUMN IF EXISTS dispositivo;
--   DROP TABLE IF EXISTS auditoria_acessos;
-- ============================================================================

ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_em     timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_por    varchar(64);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_por_id char(26);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS resolvido_em       timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS resolvido_por      char(26);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS silenciado_ate     timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS dispositivo        varchar(120);

-- Alarmes "ativos" (sem reconhecimento nem resolução) — o card do Início e a aba Ativos.
CREATE INDEX IF NOT EXISTS logs_mqtt_alerta_aberto_idx
  ON logs_mqtt (created_at DESC)
  WHERE tipo = 'alerta' AND reconhecido_em IS NULL AND resolvido_em IS NULL;

-- "Registro de atividade" (trilha filtrada por usuário).
CREATE INDEX IF NOT EXISTS logs_mqtt_usuario_idx
  ON logs_mqtt (usuario_id, created_at DESC)
  WHERE usuario_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auditoria_acessos (
  id               char(26)     PRIMARY KEY,
  -- Quem fez a mudança (NULL = sistema).
  autor_id         char(26),
  -- De quem é o acesso que mudou.
  alvo_usuario_id  char(26),
  acao             varchar(40)  NOT NULL,          -- 'convite' | 'permissoes' | 'convite_reenviado'
  mensagem         varchar(500) NOT NULL,          -- "Permissões alteradas"
  detalhes         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- Escopo, para filtrar por planta/unidade e pelo RBAC de quem lê.
  planta_ids       text[]       NOT NULL DEFAULT '{}',
  unidade_ids      text[]       NOT NULL DEFAULT '{}',
  dispositivo      varchar(120),
  created_at       timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auditoria_acessos_created_idx ON auditoria_acessos (created_at DESC);
CREATE INDEX IF NOT EXISTS auditoria_acessos_alvo_idx    ON auditoria_acessos (alvo_usuario_id);
CREATE INDEX IF NOT EXISTS auditoria_acessos_autor_idx   ON auditoria_acessos (autor_id);
