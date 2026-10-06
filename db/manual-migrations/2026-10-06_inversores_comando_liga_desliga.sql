-- 2026-10-06 — comando liga/desliga de inversor (Huawei SUN2000 e SOFAR 1…40KTL).
-- Família inversor_solar ganha os BO "ligar"/"desligar" (habilita "Configurar I/O" no editor IoT).
-- Cada modelo lista as SAÍDAS (bo_outputs) que o operador amarra aos pontos Ligar/Desligar do
-- equipamento (mesmo fluxo do relé: ponto → saída, por instância).
--   Huawei (Modbus Interface Definitions V3.0): 40200 Power on / 40201 Shutdown, WO, FC06.
--   SOFAR 1…40KTL (SOFAR Modbus User Guide 2023): bloco 0x1040…0x104F lido c/ FC04 e regravado
--   INTEIRO c/ a função proprietária 0x13; palavra 0x1042 (índice 2) = 0x0055 liga (doc).
--   0x00AA = desliga é o padrão Sofar mas NÃO está no guia → CONFIRMAR EM BANCADA.
BEGIN;
UPDATE iot_device_tipos
   SET pontos = jsonb_set(pontos, '{bo}', COALESCE(pontos->'bo', '[]'::jsonb) || '[
         {"id": "ligar", "label": "Ligar"},
         {"id": "desligar", "label": "Desligar"}
       ]'::jsonb),
       updated_at = now()
 WHERE codigo = 'inversor_solar'
   AND NOT COALESCE(pontos->'bo', '[]'::jsonb) @> '[{"id": "ligar"}]'::jsonb;

UPDATE iot_device_modelos
   SET mapeamento = jsonb_set(mapeamento, '{bo_outputs}', '[
         {"id": "ligar",    "label": "Ligar (40200 · FC06)",    "func": 6, "register": 40200, "value": 0},
         {"id": "desligar", "label": "Desligar (40201 · FC06)", "func": 6, "register": 40201, "value": 0}
       ]'::jsonb),
       updated_at = now()
 WHERE (fabricante, modelo) IN (('Huawei','SUN2000-100KTL M1'), ('Huawei','SUN2000-75KTL M1'),
                                ('Huawei','SUN2000-100KTL M2'), ('WEG','SIW500H ST060'));

UPDATE iot_device_modelos
   SET mapeamento = jsonb_set(mapeamento, '{bo_outputs}', '[
         {"id": "ligar",    "label": "Ligar (0x1042=0x55 · FC13)",    "func": 19, "start": 4160, "count": 16, "index": 2, "value": 85},
         {"id": "desligar", "label": "Desligar (0x1042=0xAA · FC13 — confirmar em bancada)", "func": 19, "start": 4160, "count": 16, "index": 2, "value": 170}
       ]'::jsonb),
       updated_at = now()
 WHERE fabricante = 'SOFAR' AND modelo = '33000TL-G2';
COMMIT;
