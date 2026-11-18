-- Fazenda Pontal / bancada do controle (18/11/2026): os 19 inversores do projeto "Controle FP - Bancada"
-- viram emulados (Sungrow SG110CX) com valores prontos: Pn 110 kW, P 100 kW (19 x 100 = 1.900 kW > 990 do contrato),
-- FP 1, 380 V. Na tela: duplo-clique no inversor → Iniciar (o 1º escolhe a porta; os outros "Mesma porta").
UPDATE iot_projetos p
SET diagrama = jsonb_set(p.diagrama, '{components}', (
      SELECT jsonb_agg(CASE WHEN c->>'type' = 'inversor' THEN
        jsonb_set(c, '{props}', (c->'props') || jsonb_build_object(
          'emulado', true, '_addr_manual', true,
          'emulacao', jsonb_build_object('bi', '{}'::jsonb, 'cfg', jsonb_build_object('tp', 1, 'tc', 1, 'decimais', '{}'::jsonb),
            'valores', jsonb_build_object(
              'nominal_power', '110', 'potencia_ativa', '100000', 'potencia_reativa', '0', 'apparent_total', '100000', 'fp', '1',
              'vab', '380', 'vbc', '380', 'vca', '380', 'ia', '151.9', 'ib', '151.9', 'ic', '151.9', 'freq', '60',
              'dc_total_power', '102000', 'work_state', '0', 'temp_interna', '45', 'daily_yield', '300', 'total_yield', '50000',
              'mppt1_voltage', '600', 'mppt2_voltage', '600', 'mppt3_voltage', '600')))) ELSE c END ORDER BY o)
      FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY AS t(c, o))),
    updated_at = now()
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;

SELECT count(*) FILTER (WHERE (c->'props'->>'emulado')::boolean) AS emulados, count(*) AS nos
FROM iot_projetos p, jsonb_array_elements(p.diagrama->'components') c
WHERE p.unidade_id = 'cmuhbmzan17mbjq7o8154c6vt' AND p.nome = 'Controle FP - Bancada' AND p.deleted_at IS NULL;
