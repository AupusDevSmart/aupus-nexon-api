-- Pivô: pontos nativos novos (docs/IOT-PIVO-PERCENTIMETRO-LAMINA.md).
--   comando "Percentimetro" = BO do motor de movimento (a TON faz o ciclo do percentímetro)
--   status  "Pressostato"   = água chegou (a partida espera antes de girar)
-- A sequência (PivoSequenciaService) acha os papéis pelo nome (/percent/, /press/).
-- Ponto sem BO/BI vinculada é ignorado (o pivô segue partindo como antes).
-- Idempotente: só acrescenta o que ainda não estiver na lista.
UPDATE tipos_equipamentos
SET propriedades_schema = jsonb_set(propriedades_schema, '{pontos_nativos,comando}',
      COALESCE(propriedades_schema->'pontos_nativos'->'comando', '[]'::jsonb)
      || '[{"id": "percentimetro", "label": "Percentimetro"}]'::jsonb),
    updated_at = now()
WHERE codigo = 'PIVO'
  AND propriedades_schema ? 'pontos_nativos'
  AND NOT COALESCE(propriedades_schema->'pontos_nativos'->'comando', '[]'::jsonb) @> '[{"id": "percentimetro"}]'::jsonb;

UPDATE tipos_equipamentos
SET propriedades_schema = jsonb_set(propriedades_schema, '{pontos_nativos,status}',
      COALESCE(propriedades_schema->'pontos_nativos'->'status', '[]'::jsonb)
      || '[{"id": "pressostato", "label": "Pressostato"}]'::jsonb),
    updated_at = now()
WHERE codigo = 'PIVO'
  AND propriedades_schema ? 'pontos_nativos'
  AND NOT COALESCE(propriedades_schema->'pontos_nativos'->'status', '[]'::jsonb) @> '[{"id": "pressostato"}]'::jsonb;

SELECT propriedades_schema->'pontos_nativos' FROM tipos_equipamentos WHERE codigo = 'PIVO';
