-- 2026-09-22 — mapa de entradas da V1: bancada provou que X12-1..6 = GP1..GP6 (o "off-by-one" era falso).
-- So' muda o texto do campo din_gp0; o valor salvo no diagrama nao muda.
BEGIN;
UPDATE tipos_equipamentos
   SET propriedades_schema = (
     SELECT jsonb_set(propriedades_schema, '{variantes}', (
       SELECT jsonb_object_agg(k, CASE WHEN k IN ('ton1','ton2','ton3','ton4') THEN
         jsonb_set(v, '{fields}', (
           SELECT jsonb_agg(CASE WHEN f->>'key' = 'din_gp0'
             THEN '{"key":"din_gp0","label":"Mapa das entradas BI (placa V1)","type":"select","options":[["","Padrão da placa V1: X12-1..6 = d1..d6 (GP1-GP6) — confirmado em bancada 22/09/2026"],["true","GP0-GP5 (NÃO usar na V1: GP0 não é entrada e fica preso em 1)"]]}'::jsonb
             ELSE f END)
           FROM jsonb_array_elements(v->'fields') f), true)
         ELSE v END)
       FROM jsonb_each(propriedades_schema->'variantes') AS e(k, v)))
   )
 WHERE codigo = 'TON1';
COMMIT;
