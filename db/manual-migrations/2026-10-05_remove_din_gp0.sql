-- 2026-10-05 — remove o campo din_gp0 das TONs V1 na paleta do editor IoT.
-- A bancada de 22/09 provou que o mapa da placa V1 e' X12-1..6 = GP1-GP6 (o que a base ja' le');
-- a opcao GP0-GP5 so' servia pra errar. O gerador nao le mais o campo.
BEGIN;
UPDATE tipos_equipamentos
   SET propriedades_schema = (
     SELECT jsonb_set(propriedades_schema, '{variantes}', (
       SELECT jsonb_object_agg(k, CASE WHEN k IN ('ton1','ton2','ton3','ton4') THEN
         jsonb_set(v, '{fields}', COALESCE((
           SELECT jsonb_agg(f) FROM jsonb_array_elements(v->'fields') f
            WHERE f->>'key' IS DISTINCT FROM 'din_gp0'), '[]'::jsonb), true)
         ELSE v END)
       FROM jsonb_each(propriedades_schema->'variantes') AS e(k, v)))
   )
 WHERE codigo = 'TON1';
COMMIT;
