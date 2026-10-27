-- 1) Pivos 1,2,3,11: os 3 medidores (PM-01/02/03) foram APAGADOS em 19/10 18:23 (provável Del no
--    unifilar para tirá-los do desenho) → backend parou de gravar as leituras, embora as TON4 sigam
--    publicando. Volta o cadastro (fora do unifilar) e cada medidor passa a aparecer no SEU pivô:
--      PM-01 (Pivo_1)    → PIVO 1 · PM-02 (Pivo_2) → PIVO 2 · PM-03 (Pivo_3_11) → PIVO 3 + Pivo 11
-- 2) Vínculo medidor→elemento (disjuntor_equipamento_id / elementos_extra) ficava SÓ em iot_componentes;
--    salvar o diagrama IoT recria os nós a partir do desenho e o apagaria. Copia para o desenho em
--    TODOS os projetos que têm vínculo (casando pelo equipamento do nó).
-- Backup: bkp_20261026e_*. ROLLBACK no fim.
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261026e_equip AS
  SELECT id, deleted_at, diagrama_id FROM equipamentos WHERE id IN ('cmqgm4hou3rs3jqvsews0zjbq','cmqglxr1u3rltjqvsfw7nuhf4','cmqgm48nk3rrxjqvs20ijg5s3');
CREATE TABLE IF NOT EXISTS bkp_20261026e_projetos AS
  SELECT id, diagrama FROM iot_projetos WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS bkp_20261026e_iot AS
  SELECT id, props FROM iot_componentes;

UPDATE equipamentos SET deleted_at = NULL, updated_at = now()
 WHERE id IN ('cmqgm4hou3rs3jqvsews0zjbq','cmqglxr1u3rltjqvsfw7nuhf4','cmqgm48nk3rrxjqvs20ijg5s3');

-- vínculos dos pivôs (tabela)
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmkmz51ts09rujqv9crh8dag9"}'::jsonb, updated_at = now()
 WHERE trim(projeto_id) = 'd7976de5b2d58d62b38e836035' AND props->>'equipamento_id' = 'cmqgm4hou3rs3jqvsews0zjbq';   -- PM-01 → PIVO 1
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmkmz5o5k09s2jqv9y9ik8vcd"}'::jsonb, updated_at = now()
 WHERE trim(projeto_id) = 'd7976de5b2d58d62b38e836035' AND props->>'equipamento_id' = 'cmqglxr1u3rltjqvsfw7nuhf4';   -- PM-02 → PIVO 2
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmkmzeuz509uwjqv9pzuoy94k", "elementos_extra": ["cmltz24sa029ojq563z1h9u1l"]}'::jsonb, updated_at = now()
 WHERE trim(projeto_id) = 'd7976de5b2d58d62b38e836035' AND props->>'equipamento_id' = 'cmqgm48nk3rrxjqvs20ijg5s3';   -- PM-03 → PIVO 3 + Pivo 11

-- vínculos copiados para o desenho (sobrevivem ao "salvar" do diagrama IoT)
UPDATE iot_projetos p SET diagrama = jsonb_set(p.diagrama, '{components}', (
  SELECT jsonb_agg(
    CASE WHEN v.eq IS NOT NULL
      THEN jsonb_set(c, '{props}', (c->'props') || v.vinc)
      ELSE c END ORDER BY ord)
  FROM jsonb_array_elements(p.diagrama->'components') WITH ORDINALITY AS t(c, ord)
  LEFT JOIN LATERAL (
    SELECT ic.props->>'equipamento_id' AS eq,
           jsonb_strip_nulls(jsonb_build_object(
             'disjuntor_equipamento_id', ic.props->'disjuntor_equipamento_id',
             'elementos_extra', ic.props->'elementos_extra')) AS vinc
    FROM iot_componentes ic
    WHERE trim(ic.projeto_id) = trim(p.id) AND ic.props ? 'disjuntor_equipamento_id'
      AND ic.props->>'equipamento_id' = c->'props'->>'equipamento_id'
    LIMIT 1) v ON true)), updated_at = now()
WHERE p.deleted_at IS NULL AND jsonb_typeof(p.diagrama->'components') = 'array'
  AND EXISTS (SELECT 1 FROM iot_componentes ic WHERE trim(ic.projeto_id) = trim(p.id) AND ic.props ? 'disjuntor_equipamento_id');
COMMIT;

-- Depois de aplicar: pm2 restart aupus-nexon-api (o backend volta a assinar os tópicos dos 3 medidores).

-- ROLLBACK:
-- BEGIN;
-- UPDATE equipamentos e SET deleted_at = b.deleted_at FROM bkp_20261026e_equip b WHERE b.id = e.id;
-- UPDATE iot_componentes c SET props = b.props FROM bkp_20261026e_iot b WHERE b.id = c.id;
-- UPDATE iot_projetos p SET diagrama = b.diagrama FROM bkp_20261026e_projetos b WHERE b.id = p.id;
-- COMMIT;
