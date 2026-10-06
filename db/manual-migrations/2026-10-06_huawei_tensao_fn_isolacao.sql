-- 2026-10-06 — família Huawei (SUN2000-100KTL M1/M2, 75KTL M1, WEG SIW500H = rebrand Huawei):
--  1) tensões FASE-NEUTRO 32069/32070/32071 (U16, ganho 10) → va/vb/vc. Já estão dentro do
--     bloco 1 (32064-32090, offsets 5/6/7) — nenhuma leitura Modbus a mais.
--  2) isolação 32088 (U16, ganho 1000 em MΩ ⇒ raw = kΩ): scale 1000→1 p/ casar com o contrato
--     (protection.insulation_resistance em kΩ, igual Sungrow). Antes saía 3,585 e a ficha
--     mostrava "4 kΩ" (era 3.585 kΩ = 3,585 MΩ).
-- Só vale p/ firmware gerado depois disto (TON em campo continua igual até regravar).
BEGIN;
UPDATE iot_device_modelos m
   SET mapeamento = jsonb_set(
         jsonb_set(m.mapeamento, '{ai_map}', (m.mapeamento->'ai_map') || '{
           "va": {"mode": "avg", "block": 1, "scale": 10, "offset": 5, "dataType": "U16"},
           "vb": {"mode": "avg", "block": 1, "scale": 10, "offset": 6, "dataType": "U16"},
           "vc": {"mode": "avg", "block": 1, "scale": 10, "offset": 7, "dataType": "U16"}
         }'::jsonb),
         '{ai_map,insulation_resistance,scale}', '1'::jsonb),
       updated_at = now()
 WHERE (m.fabricante, m.modelo) IN (('Huawei','SUN2000-100KTL M1'), ('Huawei','SUN2000-75KTL M1'),
                                    ('Huawei','SUN2000-100KTL M2'), ('WEG','SIW500H ST060'))
   AND (m.mapeamento->'ai_blocks'->1->>'start') = '32064';
COMMIT;
