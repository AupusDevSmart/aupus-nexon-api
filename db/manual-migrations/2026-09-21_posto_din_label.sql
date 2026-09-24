-- Rótulo do campo din_gp0 nas TONs V1 (só texto; o valor salvo no diagrama não muda)
BEGIN;
UPDATE tipos_equipamentos
   SET propriedades_schema = (
     SELECT jsonb_set(propriedades_schema, '{variantes}', (
       SELECT jsonb_object_agg(k, CASE WHEN k IN ('ton1','ton2','ton3','ton4') THEN
         jsonb_set(v, '{fields}', (
           SELECT jsonb_agg(CASE WHEN f->>'key' = 'din_gp0'
             THEN '{"key":"din_gp0","label":"Mapa das entradas BI (placa V1)","type":"select","options":[["true","X12-1..6 = d1..d6 (como a serigrafia — use em instalações novas)"],["","Compatibilidade: d1..d6 = X12-2..6 + M0 (TONs já instaladas no mapa antigo)"]]}'::jsonb
             ELSE f END)
           FROM jsonb_array_elements(v->'fields') f), true)
         ELSE v END)
       FROM jsonb_each(propriedades_schema->'variantes') AS e(k, v)))
   )
 WHERE codigo = 'TON1';
COMMIT;
