-- Fazenda Pontal / bancada do controle (19/11/2026): INV-01 e INV-11 com 100 kW cada (Pn 100, P 100 → 200 kW)
-- e contrato de GERAÇÃO da unidade 990 → 100 kW (o controle tem que cortar). AO FINAL VOLTAR:
--   UPDATE unidades u SET demanda_geracao = b.demanda_geracao FROM bkp_20261119_pontal_contrato b WHERE u.id = b.id;
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261119_pontal_contrato AS
SELECT id, demanda_carga, demanda_geracao, now() AS salvo_em FROM unidades WHERE id = 'cmuhbmzan17mbjq7o8154c6vt';

UPDATE unidades SET demanda_geracao = 100, updated_at = now() WHERE id = 'cmuhbmzan17mbjq7o8154c6vt';

UPDATE iot_projetos p SET
  diagrama = jsonb_set(p.diagrama, '{components}', (SELECT jsonb_agg(
      CASE WHEN c->'props'->>'name' IN ('INV-01', 'INV-11') THEN
        jsonb_set(c, '{props,emulacao,valores}', (c->'props'->'emulacao'->'valores') || jsonb_build_object(
          'nominal_power', '100', 'potencia_ativa', '100000', 'potencia_reativa', '0', 'apparent_total', '100000', 'fp', '1',
          'ia', '151.9', 'ib', '151.9', 'ic', '151.9', 'dc_total_power', '102000'))
      ELSE c END ORDER BY o)
    FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY t(c, o))),
  updated_at = now()
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;
COMMIT;

SELECT demanda_carga, demanda_geracao FROM unidades WHERE id = 'cmuhbmzan17mbjq7o8154c6vt';
SELECT * FROM bkp_20261119_pontal_contrato;
SELECT c->'props'->>'name' AS inv, c->'props'->'emulacao'->'valores'->>'nominal_power' AS pn_kw, c->'props'->'emulacao'->'valores'->>'potencia_ativa' AS p_w
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'components') c
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND c->>'type' = 'inversor';
