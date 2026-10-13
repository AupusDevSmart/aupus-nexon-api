-- 2026-10-13 — Alarmes de COMUNICAÇÃO (substitui o EquipmentMonitorService só-e-mail):
--   * o "sem comunicação" vira ALARME de verdade em logs_mqtt (Alarmes ativos, histórico,
--     reconhecimento, resolução automática) com dados_snapshot.origem = 'comunicacao';
--   * anti-oscilação (abre após o limiar; só resolve após X min estável), causa-raiz por TON,
--     inversor só alarma na janela de sol, limiar por tipo/equipamento, destinatários por usina,
--     resumo diário (WhatsApp no grupo + e-mail) que serve de lembrete enquanto estiver aberto.
BEGIN;

-- Colunas da trilha de alarmes (do 2026-09-28_1-logs-mqtt-trilha.sql — idempotente; o código
-- em produção já as usa com fallback). Só a parte de logs_mqtt.
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_em     timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_por    varchar(64);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS reconhecido_por_id char(26);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS resolvido_em       timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS resolvido_por      char(26);
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS silenciado_ate     timestamp;
ALTER TABLE logs_mqtt ADD COLUMN IF NOT EXISTS dispositivo        varchar(120);
CREATE INDEX IF NOT EXISTS logs_mqtt_alerta_aberto_idx
  ON logs_mqtt (created_at DESC)
  WHERE tipo = 'alerta' AND reconhecido_em IS NULL AND resolvido_em IS NULL;
-- alarmes de comunicação abertos (o monitor consulta a cada 2 min)
CREATE INDEX IF NOT EXISTS logs_mqtt_comunicacao_aberto_idx
  ON logs_mqtt (equipamento_id)
  WHERE tipo = 'alerta' AND resolvido_em IS NULL AND (dados_snapshot->>'origem') = 'comunicacao';

CREATE TABLE IF NOT EXISTS alarme_comunicacao_config (
  id                     varchar(20) PRIMARY KEY DEFAULT 'default',
  ativo                  boolean     NOT NULL DEFAULT true,
  email_eventos          boolean     NOT NULL DEFAULT false,  -- e-mail ao abrir/normalizar
  resumo_hora            varchar(5)  NOT NULL DEFAULT '18:00',-- horário de Brasília (fechamento do dia)
  resumo_whatsapp        boolean     NOT NULL DEFAULT false,
  resumo_email           boolean     NOT NULL DEFAULT false,
  grupo_jid              varchar(120),                        -- vazio = grupo do boletim
  inversor_janela_inicio varchar(5)  NOT NULL DEFAULT '08:00',
  inversor_janela_fim    varchar(5)  NOT NULL DEFAULT '17:30',
  estavel_min            integer     NOT NULL DEFAULT 10,     -- min estável p/ normalizar
  limiares               jsonb       NOT NULL DEFAULT '{"ton":15,"inversor":30,"medidor":30,"gateway":45,"rele":15,"outro":30}',
  ultimo_resumo_data     date,
  updated_at             timestamp   NOT NULL DEFAULT now()
);
INSERT INTO alarme_comunicacao_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS alarme_destinatarios (
  id         char(26)     PRIMARY KEY,
  planta_id  char(26)     NOT NULL REFERENCES plantas(id) ON DELETE CASCADE,
  email      varchar(200) NOT NULL,
  nome       varchar(120),
  ativo      boolean      NOT NULL DEFAULT true,
  created_at timestamp    NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alarme_destinatarios_planta_email_uk ON alarme_destinatarios (planta_id, lower(email));

CREATE TABLE IF NOT EXISTS alarme_comunicacao_limiar (
  equipamento_id char(26)  PRIMARY KEY REFERENCES equipamentos(id) ON DELETE CASCADE,
  limiar_min     integer,             -- NULL = padrão do tipo
  ignorar        boolean   NOT NULL DEFAULT false,
  updated_at     timestamp NOT NULL DEFAULT now()
);
COMMIT;
