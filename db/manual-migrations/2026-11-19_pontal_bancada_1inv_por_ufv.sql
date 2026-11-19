-- Fazenda Pontal / bancada do controle (19/11/2026): testar com UM inversor por usina.
--   UFV A = INV-01 (TON-UFV-A, end. 1) · UFV B = INV-11 (TON-UFV-B, end. 1). Os outros 17 saem do projeto IoT
--   (continuam no unifilar). Cada inversor = a usina inteira: Pn 600 kW, P 550 kW → 2 x 550 = 1.100 kW > 990 do
--   contrato: o controle tem que cortar para a geração não passar.
--   Volta com os 19: restaurar o diagrama de bkp_20261119_pontal_bancada_diagrama e Salvar na tela.
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261119_pontal_bancada_diagrama AS
SELECT id, nome, diagrama, now() AS salvo_em FROM iot_projetos
WHERE unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND nome = 'Controle FP - Bancada' AND deleted_at IS NULL;

CREATE TEMP TABLE _fora ON COMMIT DROP AS
SELECT c->>'id' AS cid
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'components') c
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL
  AND c->>'type' = 'inversor' AND c->'props'->>'name' NOT IN ('INV-01', 'INV-11');

UPDATE iot_projetos p SET
  diagrama = jsonb_set(jsonb_set(p.diagrama,
    '{components}', (SELECT jsonb_agg(
        CASE WHEN c->'props'->>'name' IN ('INV-01', 'INV-11') THEN
          jsonb_set(jsonb_set(c, '{props,modbus_address}', '1'), '{props,emulacao,valores}',
            (c->'props'->'emulacao'->'valores') || jsonb_build_object(
              'nominal_power', '600', 'potencia_ativa', '550000', 'potencia_reativa', '0', 'apparent_total', '550000', 'fp', '1',
              'ia', '835.6', 'ib', '835.6', 'ic', '835.6', 'dc_total_power', '561000'))
        ELSE c END ORDER BY o)
      FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY t(c, o)
      WHERE c->>'id' NOT IN (SELECT cid FROM _fora))),
    '{connections}', COALESCE((SELECT jsonb_agg(k ORDER BY o)
      FROM jsonb_array_elements(p.diagrama->'connections') WITH ORDINALITY t(k, o)
      WHERE k->'from'->>'componentId' NOT IN (SELECT cid FROM _fora) AND k->'to'->>'componentId' NOT IN (SELECT cid FROM _fora)), '[]'::jsonb)),
  updated_at = now()
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;
COMMIT;

SELECT c->>'type' AS tipo, c->'props'->>'name' AS nome, c->'props'->>'modbus_address' AS ende,
       c->'props'->'emulacao'->'valores'->>'nominal_power' AS pn_kw, c->'props'->'emulacao'->'valores'->>'potencia_ativa' AS p_w
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'components') c
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;
SELECT k->'from'->>'componentId' AS de, k->'to'->>'componentId' AS para, k->>'style' AS estilo
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'connections') k
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;
