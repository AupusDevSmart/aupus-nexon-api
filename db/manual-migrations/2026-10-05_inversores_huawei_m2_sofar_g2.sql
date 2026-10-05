-- 2026-10-05 — catálogo IoT: Huawei SUN2000-100KTL-M2 + SOFAR 33000TL-G2.
--
-- Huawei M2: mesmo mapa do 100KTL-M1 (Modbus Interface Definitions V3.0, Huawei 2023-01-17 —
--   M2 = Model ID 150, M1 = 142; regs/ganhos conferidos: 32016+, 32064-32090, 32106/32114, 30070+).
--   PDF em /var/www/iot_nexon/mapa_modbus/HUAWEI/.
-- SOFAR 33000TL-G2: SN "SL1…" = família L1 (20…33KTL-G2) → protocolo "SOFAR 1…40KTL"
--   (SOFAR Modbus User Guide 2023-07-24). Endereços 0x0000-0x0027 (FC03). Mapa de comunidade
--   (KTL-X, mesma família) — A VALIDAR EM BANCADA: 0x0000=2 gerando, 0x000C ×10 W = display.
--   PDFs em /var/www/iot_nexon/mapa_modbus/SOFAR/.
-- Família inversor_solar ganha va/vb/vc (tensão FASE-NEUTRO, voltage.phase_a/b/c): o Sofar só
--   informa fase-neutro. Modelos que não mapeiam esses pontos não mudam (grupo vazio não é emitido).
BEGIN;

UPDATE iot_device_tipos
   SET pontos = jsonb_set(pontos, '{ai}', (pontos->'ai') || '[
         {"id": "va", "json": "voltage.phase_a", "unit": "V", "group": "voltage", "label": "Tensão Fase A (F-N)"},
         {"id": "vb", "json": "voltage.phase_b", "unit": "V", "group": "voltage", "label": "Tensão Fase B (F-N)"},
         {"id": "vc", "json": "voltage.phase_c", "unit": "V", "group": "voltage", "label": "Tensão Fase C (F-N)"}
       ]'::jsonb),
       updated_at = now()
 WHERE codigo = 'inversor_solar'
   AND NOT (pontos->'ai') @> '[{"id": "va"}]'::jsonb;

-- Huawei SUN2000-100KTL-M2 = cópia do mapa do M1
INSERT INTO iot_device_modelos (id, tipo_id, fabricante, modelo, protocolo, connection_note, mapeamento, created_at, updated_at)
SELECT 'iot_modelo_huawei100m2____', m.tipo_id, 'Huawei', 'SUN2000-100KTL M2', 'tcp/rtu',
       'Huawei 100KTL-M2 (Model ID 150), mapa = M1 (10 MPPT x 2 strings). Com SmartLogger/datalogger: TCP (evita 2º mestre RS485). Sem logger: RS485 9600 8N1, endereço no app SUN2000. Regs 30070+, 32016-32055, 32064-32090, 32106-32115.',
       jsonb_set(m.mapeamento, '{catalog_id}', '"huawei-sun2000-100ktl-m2"'), now(), now()
  FROM iot_device_modelos m
 WHERE m.fabricante = 'Huawei' AND m.modelo = 'SUN2000-100KTL M1'
ON CONFLICT (fabricante, modelo) DO NOTHING;

-- SOFAR 33000TL-G2 (protocolo SOFAR 1…40KTL)
INSERT INTO iot_device_modelos (id, tipo_id, fabricante, modelo, protocolo, connection_note, mapeamento, created_at, updated_at)
SELECT 'iot_modelo_sofar33g2______', t.id, 'SOFAR', '33000TL-G2', 'rtu',
       'SOFAR 20-33KTL-G2 (SN SL1), protocolo SOFAR 1-40KTL. RS485 9600 8N1, FC03 0x0000-0x0027. 2 MPPT (corrente PV1/PV2 = string1/2). Tensão F-N. ⚠️ VALIDAR EM BANCADA: 0x0000=2 gerando; 0x000C (x10 W) = display.',
       '{
         "catalog_id": "sofar-33000tl-g2",
         "word_order": "high_first",
         "num_mppts": 2,
         "num_strings": 2,
         "ai_blocks": [
           {"func": 3, "start": 0, "count": 40, "label": "Regs 0x0000-0x0027: estado, falhas, PV1/PV2, saída CA, energia, temperaturas"}
         ],
         "ai_map": {
           "work_state":         {"block": 0, "offset": 0,  "dataType": "U16", "scale": 1,   "mode": "last"},
           "mppt1_voltage":      {"block": 0, "offset": 6,  "dataType": "U16", "scale": 10,  "mode": "avg"},
           "string1_current":    {"block": 0, "offset": 7,  "dataType": "S16", "scale": 100, "mode": "avg"},
           "mppt2_voltage":      {"block": 0, "offset": 8,  "dataType": "U16", "scale": 10,  "mode": "avg"},
           "string2_current":    {"block": 0, "offset": 9,  "dataType": "S16", "scale": 100, "mode": "avg"},
           "potencia_ativa":     {"block": 0, "offset": 12, "dataType": "U16", "scale": 0.1, "mode": "last"},
           "potencia_reativa":   {"block": 0, "offset": 13, "dataType": "S16", "scale": 0.1, "mode": "last"},
           "freq":               {"block": 0, "offset": 14, "dataType": "U16", "scale": 100, "mode": "last"},
           "va":                 {"block": 0, "offset": 15, "dataType": "U16", "scale": 10,  "mode": "avg"},
           "ia":                 {"block": 0, "offset": 16, "dataType": "U16", "scale": 100, "mode": "avg"},
           "vb":                 {"block": 0, "offset": 17, "dataType": "U16", "scale": 10,  "mode": "avg"},
           "ib":                 {"block": 0, "offset": 18, "dataType": "U16", "scale": 100, "mode": "avg"},
           "vc":                 {"block": 0, "offset": 19, "dataType": "U16", "scale": 10,  "mode": "avg"},
           "ic":                 {"block": 0, "offset": 20, "dataType": "U16", "scale": 100, "mode": "avg"},
           "total_yield":        {"block": 0, "offset": 21, "dataType": "U32", "scale": 1,   "mode": "last"},
           "total_running_time": {"block": 0, "offset": 23, "dataType": "U32", "scale": 1,   "mode": "last"},
           "daily_yield":        {"block": 0, "offset": 25, "dataType": "U16", "scale": 100, "mode": "last"},
           "daily_running_time": {"block": 0, "offset": 26, "dataType": "U16", "scale": 1,   "mode": "last"},
           "temp_interna":       {"block": 0, "offset": 28, "dataType": "S16", "scale": 1,   "mode": "last"},
           "bus_voltage":        {"block": 0, "offset": 29, "dataType": "U16", "scale": 10,  "mode": "last"}
         },
         "bi_map": {},
         "bo_map": {}
       }'::jsonb, now(), now()
  FROM iot_device_tipos t
 WHERE t.codigo = 'inversor_solar'
ON CONFLICT (fabricante, modelo) DO NOTHING;

COMMIT;
