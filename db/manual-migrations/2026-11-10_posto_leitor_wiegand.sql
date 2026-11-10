-- Posto de combustível: campo "Leitor RFID" no nó da bomba (diagrama IoT).
--   simulado   = comandos card/mat (como hoje; padrão)
--   wiegand_ai = leitor Wiegand com D0 (verde) na AI1 e D1 (branco) na AI2 da TON-V2
-- + "Wiegand: ignorar a mesma tag por (s)". Entra na seção "Leitor & fluxômetro", antes do K-fator.
-- Idempotente (remove e reinsere os dois campos).
BEGIN;

UPDATE tipos_equipamentos t
SET propriedades_schema = jsonb_set(
      jsonb_set(t.propriedades_schema, '{fields}', novo.fields),
      '{defaults}', coalesce(t.propriedades_schema->'defaults', '{}'::jsonb) || '{"leitor_rfid": "simulado", "wiegand_antirep_s": 2}'::jsonb),
    updated_at = now()
FROM (
  SELECT id,
         (SELECT jsonb_agg(f ORDER BY ord)
            FROM (
              SELECT f, i * 10 AS ord
              FROM jsonb_array_elements(propriedades_schema->'fields') WITH ORDINALITY AS e(f, i)
              WHERE f->>'key' NOT IN ('leitor_rfid', 'wiegand_antirep_s')
              UNION ALL
              SELECT '{"key": "leitor_rfid", "type": "select", "label": "Leitor RFID", "section": "Leitor & fluxômetro", "wide": true,
                       "options": [["simulado", "Simulado — comandos card/mat (bancada)"], ["wiegand_ai", "Wiegand nas AI1/AI2 (D0 verde → AI1, D1 branco → AI2)"]]}'::jsonb,
                     (SELECT i * 10 - 2 FROM jsonb_array_elements(propriedades_schema->'fields') WITH ORDINALITY AS e(f, i) WHERE f->>'key' = 'k_fator')
              UNION ALL
              SELECT '{"key": "wiegand_antirep_s", "type": "number", "label": "Wiegand: ignorar a mesma tag por (s)", "section": "Leitor & fluxômetro", "placeholder": "2"}'::jsonb,
                     (SELECT i * 10 - 1 FROM jsonb_array_elements(propriedades_schema->'fields') WITH ORDINALITY AS e(f, i) WHERE f->>'key' = 'k_fator')
            ) x) AS fields
  FROM tipos_equipamentos
  WHERE propriedades_schema->>'palette_key' = 'bomba'
) novo
WHERE t.id = novo.id;

-- Conferência: campos da seção "Leitor & fluxômetro" na ordem
SELECT f->>'key' AS campo, f->>'label' AS rotulo
FROM tipos_equipamentos, jsonb_array_elements(propriedades_schema->'fields') AS f
WHERE propriedades_schema->>'palette_key' = 'bomba' AND f->>'section' = 'Leitor & fluxômetro';

COMMIT;
