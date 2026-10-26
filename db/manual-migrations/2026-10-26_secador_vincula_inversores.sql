-- SECADOR + UFV (Chimarrão): os 2 inversores do diagrama IoT não tinham equipamento_id — a ficha
-- não achava os ajustes (limite/FP/reativo). Vínculo pelo endereço Modbus = sufixo do tópico.
--   endereço 1 (weg-siw500h)           → INV-01 (…/Inversor_1/data) cmsyn70eq00d5jqa3lwczv0s5
--   endereço 2 (huawei-sun2000-100ktl) → Inv 2  (…/Inversor_2/data) cmluuhqbf05jojq560wjsrfbf
CREATE TABLE IF NOT EXISTS bkp_20261026_secador_vinculo AS
  SELECT 'projeto'::text AS origem, id::text AS id, diagrama AS dado FROM iot_projetos WHERE id = 'f5065bf43ea940af2b4d1ad75d'
  UNION ALL
  SELECT 'componente', id::text, props FROM iot_componentes WHERE trim(projeto_id) = 'f5065bf43ea940af2b4d1ad75d' AND tipo = 'inversor';

UPDATE iot_projetos p SET diagrama = jsonb_set(p.diagrama, '{components}', (
  SELECT jsonb_agg(CASE
    WHEN c->>'type' = 'inversor' AND c->'props'->>'modbus_address' = '1' THEN jsonb_set(c, '{props,equipamento_id}', '"cmsyn70eq00d5jqa3lwczv0s5"')
    WHEN c->>'type' = 'inversor' AND c->'props'->>'modbus_address' = '2' THEN jsonb_set(c, '{props,equipamento_id}', '"cmluuhqbf05jojq560wjsrfbf"')
    ELSE c END ORDER BY ord)
  FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY AS t(c, ord))), updated_at = now()
WHERE p.id = 'f5065bf43ea940af2b4d1ad75d';

UPDATE iot_componentes SET props = props || '{"equipamento_id": "cmsyn70eq00d5jqa3lwczv0s5"}'::jsonb, equipamento_id = 'cmsyn70eq00d5jqa3lwczv0s5', updated_at = now()
WHERE trim(projeto_id) = 'f5065bf43ea940af2b4d1ad75d' AND tipo = 'inversor' AND props->>'modbus_address' = '1';
UPDATE iot_componentes SET props = props || '{"equipamento_id": "cmluuhqbf05jojq560wjsrfbf"}'::jsonb, equipamento_id = 'cmluuhqbf05jojq560wjsrfbf', updated_at = now()
WHERE trim(projeto_id) = 'f5065bf43ea940af2b4d1ad75d' AND tipo = 'inversor' AND props->>'modbus_address' = '2';
