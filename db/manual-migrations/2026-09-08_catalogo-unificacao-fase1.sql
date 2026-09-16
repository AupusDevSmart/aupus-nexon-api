-- Reestrutura Fase 3 (unificação) — Passo 1: schema + seed do catálogo único.
-- Categorias: limpa 10 órfãs + cria 4 (nome=categoria, pedido do usuário).
-- tipos_equipamentos: FK device_tipo_id -> iot_device_tipos (Q1=A) + flags de
-- disponibilidade por editor (disp_unifilar / disp_iot). origem (unifilar|iot) é
-- do EQUIPAMENTO; a flag de disponibilidade é do TIPO (um tipo pode ser oferecido
-- nos dois pickers, ex.: Inversor/Bomba/Carregador/Pivô/Medidor Concessionária).
-- Backups: db/backups/2026-09-08_pre-reestrutura/.

-- ===== A) Categorias: 4 novas (antes do delete p/ não faltar destino) =====
INSERT INTO categorias_equipamentos (id, nome) VALUES
  (rpad('catconversor', 26, '0'),  'Conversor'),
  (rpad('catdatalogger',26, '0'),  'Datalogger'),
  (rpad('catbroker',    26, '0'),  'Broker MQTT'),
  (rpad('catroteador',  26, '0'),  'Roteador');

-- ===== B) Categorias órfãs (0 tipos usando) -> apagar =====
DELETE FROM categorias_equipamentos WHERE nome IN (
  'QGBT','Skid','SoftStarter','Transformador de Corrente (TC)','Transformador de Potencial (TP)',
  'Disjuntor MT','Carregador DC 120kW','Inversor Frequência','Medidor SSU','String Fotovoltaica');

-- ===== C) tipos_equipamentos: novas colunas =====
ALTER TABLE tipos_equipamentos ADD COLUMN IF NOT EXISTS disp_unifilar  boolean NOT NULL DEFAULT true;
ALTER TABLE tipos_equipamentos ADD COLUMN IF NOT EXISTS disp_iot       boolean NOT NULL DEFAULT false;
ALTER TABLE tipos_equipamentos ADD COLUMN IF NOT EXISTS device_tipo_id character(26);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tipos_device_tipo') THEN
    ALTER TABLE tipos_equipamentos ADD CONSTRAINT fk_tipos_device_tipo
      FOREIGN KEY (device_tipo_id) REFERENCES iot_device_tipos(id);
  END IF;
END $$;

-- ===== D) Seed das flags de disponibilidade (default = unifilar-only) =====
-- ambos (unifilar + iot)
UPDATE tipos_equipamentos SET disp_iot=true
  WHERE nome IN ('Medidor Concessionária','Inversor Fotovoltaico','Carregador Elétrico','Bomba de Combustível','Pivô de Irrigação');
-- iot-only
UPDATE tipos_equipamentos SET disp_unifilar=false, disp_iot=true
  WHERE nome IN ('Power Meter','Relé de Proteção','TON','A966');
-- unifilar-only (Disjuntor, Transformador, Módulo FV, Motor, Chave, Banco Capacitor) = default, sem update.

-- ===== E) Vínculo tipo -> família de device (register map) =====
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='inversor_solar')      WHERE nome='Inversor Fotovoltaico';
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='medidor_energia')     WHERE nome IN ('Power Meter','Medidor Concessionária');
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='rele_protecao')       WHERE nome='Relé de Proteção';
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='gateway_medidor')     WHERE nome='A966';
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='carregador_eletrico') WHERE nome='Carregador Elétrico';
UPDATE tipos_equipamentos SET device_tipo_id=(SELECT id FROM iot_device_tipos WHERE codigo='bomba_combustivel')   WHERE nome='Bomba de Combustível';

-- ===== F) Criar os 4 tipos IoT (iot-only) =====
INSERT INTO tipos_equipamentos (id, codigo, nome, categoria_id, fabricante, updated_at, disp_unifilar, disp_iot) VALUES
  (rpad('tipoconversor', 26,'0'),'CONVERSOR',  'Conversor',   rpad('catconversor', 26,'0'), 'Genérico', now(), false, true),
  (rpad('tipodatalogger',26,'0'),'DATALOGGER', 'Datalogger',  rpad('catdatalogger',26,'0'), 'Genérico', now(), false, true),
  (rpad('tipobroker',    26,'0'),'BROKER_MQTT','Broker MQTT', rpad('catbroker',    26,'0'), 'Genérico', now(), false, true),
  (rpad('tiporoteador',  26,'0'),'ROTEADOR',   'Roteador',    rpad('catroteador',  26,'0'), 'Genérico', now(), false, true);

-- ===== SANITY =====
\echo '--- categorias restantes (esperado 15 + 4 = 19... na verdade 25-10+4=19) ---'
SELECT count(*) categorias FROM categorias_equipamentos;
\echo '--- catálogo de tipos: nome, disp_unifilar, disp_iot, device ---'
SELECT t.nome, t.disp_unifilar u, t.disp_iot i, dt.codigo AS device
  FROM tipos_equipamentos t LEFT JOIN iot_device_tipos dt ON TRIM(t.device_tipo_id)=TRIM(dt.id)
  ORDER BY t.disp_unifilar DESC, t.disp_iot DESC, t.nome;
