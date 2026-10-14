-- Medidor Concessionária (nó SSU do IoT): Ke deixa de ser digitado em kWh/pulso.
-- Ke = 0,3 Wh/pulso (constante do medidor no secundário, validada em bancada 14/10/2026:
-- 220 V × 5 A por 5 min = 305 pulsos) × relação do TC × relação do TP.
-- O campo "ke" fica como sobrescrita manual opcional. A paleta do banco sobrepõe o JS
-- (iot-diagram.v2.js tem a mesma mudança).
UPDATE tipos_equipamentos
SET propriedades_schema = jsonb_set(
      jsonb_set(propriedades_schema, '{fields}', (
        SELECT jsonb_agg(x ORDER BY ord) FROM (
          SELECT f AS x, (o * 10) AS ord FROM jsonb_array_elements(propriedades_schema->'fields') WITH ORDINALITY AS t(f, o)
           WHERE f->>'key' <> 'ke'
          UNION ALL
          SELECT jsonb_build_object('key', 'relacao_tc', 'type', 'number', 'label', 'Relação do TC (ex.: 80/5 → 16; medição direta → 1)', 'placeholder', '1'), 21
          UNION ALL
          SELECT jsonb_build_object('key', 'relacao_tp', 'type', 'number', 'label', 'Relação do TP (sem TP → 1)', 'placeholder', '1'), 22
          UNION ALL
          SELECT jsonb_build_object('key', 'ke', 'type', 'number', 'label', 'Ke manual em kWh/pulso (opcional — vazio = 0,0003 × TC × TP)', 'placeholder', 'calculado'), 23
        ) s)),
      '{defaults}', (propriedades_schema->'defaults') || '{"relacao_tc": 1, "relacao_tp": 1}'::jsonb),
    updated_at = now()
WHERE codigo = 'EQTL001' AND NOT (propriedades_schema->'fields') @> '[{"key": "relacao_tc"}]';
