-- FASE 6 — cleanup final: remove o io_config.bo PERSISTIDO (props e cache do diagrama).
-- A fonte da verdade do comando de relé passou a ser iot_vinculos(modbus_bo). Este scrub
-- só apaga a CÓPIA vestigial em props/diagrama — os comandos seguem no vínculo.
--
-- ⚠️ NÃO RODAR até CONFIRMAR no app que "Configurar I/O" lê/salva o comando via vínculo.
--    Depois do scrub NÃO há mais fallback em props: relé sem vínculo perderia o comando.
--
-- PRÉ-REQUISITO (já verificado 2026-09-11): cobertura 1:1 — todo io_config.bo tem
--   modbus_bo ativo no vínculo (props_sem_vinculo = 0). RE-VERIFICAR antes de aplicar:
--   WITH io AS (SELECT COALESCE(NULLIF(TRIM(c.equipamento_id),''),c.props->>'equipamento_id') eq,
--                TRIM(k.value->>'ponto_id') ponto FROM iot_componentes c
--                CROSS JOIN LATERAL jsonb_each(COALESCE(c.props->'io_config'->'bo','{}'::jsonb)) k
--                WHERE TRIM(COALESCE(k.value->>'ponto_id',''))<>''),
--        vin AS (SELECT TRIM(fonte_equipamento_id) eq, TRIM(equipamento_ponto_id) ponto
--                FROM iot_vinculos WHERE fonte_tipo='modbus_bo' AND ativo AND deleted_at IS NULL)
--   SELECT count(*) FROM io WHERE NOT EXISTS (SELECT 1 FROM vin WHERE vin.eq=io.eq AND vin.ponto=io.ponto);
--   -- precisa dar 0.

BEGIN;

-- 1) BACKUP reversível (ponto de retorno).
CREATE TABLE IF NOT EXISTS backup_20260911_iocfg_componentes AS
  SELECT id, props FROM iot_componentes WHERE props->'io_config' ? 'bo';
CREATE TABLE IF NOT EXISTS backup_20260911_iocfg_projetos AS
  SELECT id, diagrama FROM iot_projetos
  WHERE diagrama->'components' @> '[{"props":{"io_config":{"bo":{}}}}]'::jsonb
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(diagrama->'components','[]'::jsonb)) c
                WHERE c->'props'->'io_config' ? 'bo');

-- 2) Strip do io_config.bo na FONTE normalizada (iot_componentes.props).
UPDATE iot_componentes
SET props = jsonb_set(props, '{io_config}', (props->'io_config') - 'bo')
WHERE props->'io_config' ? 'bo';

-- 3) Strip do io_config.bo no CACHE do diagrama (iot_projetos.diagrama.components[]).
UPDATE iot_projetos p
SET diagrama = jsonb_set(
      p.diagrama, '{components}',
      (SELECT COALESCE(jsonb_agg(
                CASE WHEN comp->'props'->'io_config' ? 'bo'
                     THEN jsonb_set(comp, '{props,io_config}', (comp->'props'->'io_config') - 'bo')
                     ELSE comp END
              ), '[]'::jsonb)
       FROM jsonb_array_elements(p.diagrama->'components') comp))
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.diagrama->'components','[]'::jsonb)) c
              WHERE c->'props'->'io_config' ? 'bo');

-- 4) Conferir que sumiu (deve dar 0 nos dois):
--   SELECT count(*) FROM iot_componentes WHERE props->'io_config' ? 'bo';
--   SELECT count(*) FROM iot_projetos p WHERE EXISTS (SELECT 1 FROM
--     jsonb_array_elements(COALESCE(p.diagrama->'components','[]'::jsonb)) c WHERE c->'props'->'io_config' ? 'bo');

COMMIT;

-- REVERSÃO (se preciso voltar ao ponto que funcionava):
--   UPDATE iot_componentes t SET props = b.props FROM backup_20260911_iocfg_componentes b WHERE t.id=b.id;
--   UPDATE iot_projetos t SET diagrama = b.diagrama FROM backup_20260911_iocfg_projetos b WHERE t.id=b.id;
