-- Fazenda Pontal / bancada do controle (18/11/2026): TON-UFV-A e TON-UFV-B -> TON1 V2 (V2 sem LoRa e sem relés:
-- RS485 + WiFi bastam; tudo no WiFi). TON-MED fica TON4 V2 (SSU). Diagrama + componentes + equipamento.
BEGIN;
UPDATE iot_projetos p
SET diagrama = jsonb_set(p.diagrama, '{components}', (
      SELECT jsonb_agg(CASE WHEN c->'props'->>'name' IN ('TON-UFV-A', 'TON-UFV-B') THEN jsonb_set(c, '{type}', '"ton1v2"') ELSE c END ORDER BY o)
      FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY AS t(c, o))),
    updated_at = now()
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;

UPDATE iot_componentes ic SET tipo = 'ton1v2', updated_at = now()
FROM iot_projetos p
WHERE p.id = ic.projeto_id AND p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada'
  AND ic.props->>'name' IN ('TON-UFV-A', 'TON-UFV-B');

UPDATE equipamentos SET tipo_equipamento = 'TON1V2', updated_at = now()
WHERE unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND nome IN ('TON-UFV-A', 'TON-UFV-B') AND deleted_at IS NULL;
COMMIT;

SELECT c->'props'->>'name' AS ton, c->>'type' AS tipo
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'components') c
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND c->>'type' ~ '^ton';
