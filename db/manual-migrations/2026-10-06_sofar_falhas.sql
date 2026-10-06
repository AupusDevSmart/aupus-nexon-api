-- 2026-10-06 — SOFAR 33000TL-G2: registradores de falha 0x0001-0x0005 (bitfields ID01…ID80,
-- protocolo SOFAR 1…40KTL) → status.fault_1..fault_5 (0 = sem falha). Já estão no bloco lido
-- (0x0000-0x0027): nenhuma leitura Modbus a mais. Pontos novos na família inversor_solar.
BEGIN;
UPDATE iot_device_tipos
   SET pontos = jsonb_set(pontos, '{ai}', (pontos->'ai') || '[
         {"id": "fault_1", "json": "status.fault_1", "unit": "", "group": "status", "label": "Falha 1 (bits)"},
         {"id": "fault_2", "json": "status.fault_2", "unit": "", "group": "status", "label": "Falha 2 (bits)"},
         {"id": "fault_3", "json": "status.fault_3", "unit": "", "group": "status", "label": "Falha 3 (bits)"},
         {"id": "fault_4", "json": "status.fault_4", "unit": "", "group": "status", "label": "Falha 4 (bits)"},
         {"id": "fault_5", "json": "status.fault_5", "unit": "", "group": "status", "label": "Falha 5 (bits)"}
       ]'::jsonb),
       updated_at = now()
 WHERE codigo = 'inversor_solar'
   AND NOT (pontos->'ai') @> '[{"id": "fault_1"}]'::jsonb;

UPDATE iot_device_modelos
   SET mapeamento = jsonb_set(mapeamento, '{ai_map}', (mapeamento->'ai_map') || '{
         "fault_1": {"block": 0, "offset": 1, "dataType": "U16", "scale": 1, "mode": "last"},
         "fault_2": {"block": 0, "offset": 2, "dataType": "U16", "scale": 1, "mode": "last"},
         "fault_3": {"block": 0, "offset": 3, "dataType": "U16", "scale": 1, "mode": "last"},
         "fault_4": {"block": 0, "offset": 4, "dataType": "U16", "scale": 1, "mode": "last"},
         "fault_5": {"block": 0, "offset": 5, "dataType": "U16", "scale": 1, "mode": "last"}
       }'::jsonb),
       updated_at = now()
 WHERE fabricante = 'SOFAR' AND modelo = '33000TL-G2';
COMMIT;
