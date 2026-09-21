-- 2026-09-21 — POSTO DE COMBUSTÍVEL (bomba controlada pela TON, lib bomba_posto)
-- Rodar ANTES de reiniciar o backend novo (pm2 restart aupus-nexon-api).
-- Idempotente. Docs: "Posto de Combustível na Fazenda — Como funciona", "Teste em bancada",
-- docs/POSTO-BANCADA-KIT.md.
BEGIN;

-- 1) Transações: identificação dupla (tag + matrícula), motivo de fim, validação (online|offline|manual)
ALTER TABLE abastecimentos
  ADD COLUMN IF NOT EXISTS matricula     varchar(16),
  ADD COLUMN IF NOT EXISTS operador_nome varchar(120),
  ADD COLUMN IF NOT EXISTS fim_motivo    varchar(24),
  ADD COLUMN IF NOT EXISTS validacao     varchar(12);
CREATE INDEX IF NOT EXISTS idx_abastecimentos_uid_created ON abastecimentos (uid, created_at DESC);

-- 2) Tags (máquinas): matrículas permitidas (jsonb []; vazio = qualquer operador cadastrado)
ALTER TABLE rfid_autorizados ADD COLUMN IF NOT EXISTS matriculas jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 3) Operadores (matrícula digitada na IHM)
CREATE TABLE IF NOT EXISTS bomba_operadores (
  id         varchar(26) PRIMARY KEY,
  matricula  varchar(16)  NOT NULL,
  nome       varchar(120),
  bomba_id   varchar(26),
  planta_id  varchar(26),
  ativo      boolean      NOT NULL DEFAULT true,
  created_at timestamp    NOT NULL DEFAULT now(),
  updated_at timestamp    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bomba_operadores_planta ON bomba_operadores (planta_id, matricula);

-- 4) Eventos da TON (<base>/evento)
CREATE TABLE IF NOT EXISTS bomba_eventos (
  id             varchar(26) PRIMARY KEY,
  equipamento_id varchar(26) NOT NULL,
  tipo           varchar(24),
  motivo         varchar(32),
  uid            varchar(64),
  matricula      varchar(16),
  seq            integer,
  ts             timestamp,
  created_at     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bomba_eventos_eq ON bomba_eventos (equipamento_id, created_at DESC);

-- 5) Estado da bomba: telemetria completa + versão da lista que a TON tem
ALTER TABLE bomba_combustivel_config
  ADD COLUMN IF NOT EXISTS ultimo_json  jsonb,
  ADD COLUMN IF NOT EXISTS lista_versao bigint;

-- 6) Catálogo IoT: papéis dos pontos da bomba (ensureBombaEquipamentos semeia daqui)
UPDATE iot_device_tipos SET pontos = '{"bo": [{"id": "ligar", "label": "Ligar"}, {"id": "permissao", "label": "Permissão"}, {"id": "solenoide", "label": "Solenoide"}, {"id": "sinaleiro", "label": "Sinaleiro"}], "bi": [{"id": "contator", "label": "Contator"}, {"id": "auto_manual", "label": "Auto/Manual"}, {"id": "emergencia", "label": "Emergência"}, {"id": "bico", "label": "Bico"}, {"id": "boia_min", "label": "Boia mínimo"}, {"id": "boia_alta", "label": "Boia alta"}], "ai": [{"id": "nivel", "label": "Nível", "unit": "%"}]}'::jsonb WHERE codigo = 'bomba_combustivel';

-- 7) Paleta do editor IoT (DB sobrescreve o JS): props/campos novos da bomba + toggle din_gp0 nas TONs V1
UPDATE tipos_equipamentos
   SET propriedades_schema = jsonb_set(jsonb_set(propriedades_schema, '{fields}', '[{"key": "name", "label": "Nome", "type": "text", "wide": true, "section": "Identificação"}, {"key": "equipamento_id", "label": "Equipamento NexON (RFID / relatório)", "type": "text", "wide": true}, {"key": "exigir_matricula", "label": "Exigir matrícula do operador (tag + matrícula)", "type": "select", "section": "Identificação", "options": [["true", "Sim — tag da máquina + matrícula (IHM)"], ["false", "Não — só a tag"]]}, {"key": "k_fator", "label": "K-fator do fluxômetro (pulsos/L)", "type": "number", "placeholder": "450", "section": "Leitor & fluxômetro"}, {"key": "pulso_ms", "label": "Pulso do BO1 \"liga\" (ms)", "type": "number", "placeholder": "500", "section": "Contator"}, {"key": "espera_bi1_ms", "label": "Espera pelo contato auxiliar (BI1) na partida/desligamento (ms)", "type": "number", "placeholder": "1000"}, {"key": "janela_mat_s", "label": "Janela entre tag e matrícula (s)", "type": "number", "placeholder": "60", "section": "Operação"}, {"key": "auth_timeout_s", "label": "Espera pela resposta do NexON antes de validar offline (s)", "type": "number", "placeholder": "3"}, {"key": "fluxo_parado_s", "label": "Fluxo parado para encerrar (s) — bancada 10 / campo 30", "type": "number", "placeholder": "30"}, {"key": "timeout_s", "label": "Tempo máximo de abastecimento (s) — bancada 30 / campo 600", "type": "number", "placeholder": "600"}, {"key": "nivel_min_pct", "label": "Nível mínimo no AI para liberar (%)", "type": "number", "placeholder": "10"}, {"key": "telemetria_s", "label": "Telemetria <base>/bomba a cada (s)", "type": "number", "placeholder": "30"}, {"key": "uid_teste", "label": "UID de teste (comando \"card\" sem argumento)", "type": "text", "placeholder": "PC-07", "section": "Bancada"}, {"key": "mat_teste", "label": "Matrícula de teste (comando \"mat\" sem argumento)", "type": "text", "placeholder": "1234"}]'::jsonb, true), '{defaults}', '{"name": "Bomba de Combustível", "equipamento_id": "", "exigir_matricula": true, "k_fator": 450, "pulso_ms": 500, "espera_bi1_ms": 1000, "janela_mat_s": 60, "auth_timeout_s": 3, "fluxo_parado_s": 30, "timeout_s": 600, "nivel_min_pct": 10, "telemetria_s": 30, "uid_teste": "PC-07", "mat_teste": "1234"}'::jsonb, true)
 WHERE codigo = 'BOMBA_COMBUSTIVEL';
UPDATE tipos_equipamentos
   SET propriedades_schema = (
     SELECT jsonb_set(propriedades_schema, '{variantes}', (
       SELECT jsonb_object_agg(k, CASE WHEN k IN ('ton1','ton2','ton3','ton4')
                                          AND NOT (v->'fields') @> '[{"key":"din_gp0"}]'::jsonb
                                       THEN jsonb_set(v, '{fields}', (v->'fields') || '{"key": "din_gp0", "label": "Entradas DIN1-6 = GP0-GP5 (mapa corrigido da placa v1a — só TONs novas)", "type": "select", "options": [["", "Não (padrão histórico: GP1-GP6)"], ["true", "Sim — DIN1-6 físicas (posto/bancada)"]]}'::jsonb, true)
                                       ELSE v END)
       FROM jsonb_each(propriedades_schema->'variantes') AS e(k, v)))
   )
 WHERE codigo = 'TON1' AND propriedades_schema ? 'variantes';

-- 8) BC-01 (projeto "IoT Posto"): renomeia os pontos antigos preservando os vínculos ton_bo/ton_bi.
--    Depois, no sheet da TON3: Permissão→BO2, Contator→BI1, Auto/Manual→BI2, Emergência→BI3, Bico→BI4, Boia mínimo→BI5, Boia alta→BI6.
UPDATE equipamento_pontos SET nome = 'Permissão' WHERE TRIM(equipamento_id) = 'cmt07i88j0014jqyiue0j75na' AND nome = 'Desligar';
UPDATE equipamento_pontos SET nome = 'Contator'  WHERE TRIM(equipamento_id) = 'cmt07i88j0014jqyiue0j75na' AND nome = 'Cartão';

COMMIT;
