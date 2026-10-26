-- UBS + UFV: inversor 1 (INV-01, Modbus 1, RS485 direto na TON) trocado por WEG SIW400G T060 W00
-- (FoxESS, SunSpec). MPPTs/strings do T060 não são publicados: lê as 24 entradas do protocolo e o
-- número exato é fixado depois de ver quais têm tensão (o perfil de strings marca as vazias).
CREATE TABLE IF NOT EXISTS bkp_20261026_ubs_inv01 AS
  SELECT 'projeto'::text AS origem, id::text AS id, diagrama AS dado FROM iot_projetos WHERE id = 'b69b888b20cb18658ab8f8f7d5'
  UNION ALL
  SELECT 'componente', id::text, props FROM iot_componentes
  WHERE trim(projeto_id) = 'b69b888b20cb18658ab8f8f7d5' AND props->>'equipamento_id' = 'cmluuw1hx05ltjq56e2a3ee7k';

UPDATE iot_projetos p SET diagrama = jsonb_set(p.diagrama, '{components}', (
  SELECT jsonb_agg(CASE WHEN c->>'id' = 'c23'
    THEN jsonb_set(jsonb_set(jsonb_set(c, '{props,catalog_id}', '"weg-siw400g"'), '{props,num_mppts}', '24'), '{props,num_strings}', '24')
    ELSE c END ORDER BY ord)
  FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY AS t(c, ord))), updated_at = now()
WHERE p.id = 'b69b888b20cb18658ab8f8f7d5';

UPDATE iot_componentes SET props = props || '{"catalog_id": "weg-siw400g", "num_mppts": 24, "num_strings": 24}'::jsonb, updated_at = now()
WHERE trim(projeto_id) = 'b69b888b20cb18658ab8f8f7d5' AND props->>'equipamento_id' = 'cmluuw1hx05ltjq56e2a3ee7k';
