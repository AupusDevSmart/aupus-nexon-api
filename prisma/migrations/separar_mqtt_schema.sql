-- ========================================================================
-- MIGRATION: Separar MQTT Schema de Campos Técnicos
-- Data: 2026-01-07
-- Descrição: Criar coluna separada para schema MQTT (JSON Schema)
-- ========================================================================

-- ✅ STEP 1: Adicionar nova coluna mqtt_schema
ALTER TABLE "tipos_equipamentos"
  ADD COLUMN "mqtt_schema" JSONB;

-- ✅ STEP 2: Migrar schemas MQTT existentes
-- METER_M160, INVERSOR e PIVO usam propriedades_schema para JSON Schema MQTT

-- Migrar METER_M160
UPDATE "tipos_equipamentos"
SET mqtt_schema = propriedades_schema,
    propriedades_schema = NULL
WHERE codigo = 'METER_M160'
  AND propriedades_schema IS NOT NULL
  AND propriedades_schema->>'type' = 'object'; -- Detecta JSON Schema (vs campos técnicos)

-- Migrar INVERSOR
UPDATE "tipos_equipamentos"
SET mqtt_schema = propriedades_schema,
    propriedades_schema = NULL
WHERE codigo = 'INVERSOR'
  AND propriedades_schema IS NOT NULL
  AND propriedades_schema->>'type' = 'object';

-- Migrar PIVO
UPDATE "tipos_equipamentos"
SET mqtt_schema = propriedades_schema,
    propriedades_schema = NULL
WHERE codigo = 'PIVO'
  AND propriedades_schema IS NOT NULL
  AND propriedades_schema->>'type' = 'object';

-- ✅ STEP 3: Adicionar comentários explicativos
COMMENT ON COLUMN tipos_equipamentos.propriedades_schema IS 'Campos técnicos do equipamento (formato: {campos: [{campo, tipo, unidade, obrigatorio}]})';
COMMENT ON COLUMN tipos_equipamentos.mqtt_schema IS 'JSON Schema para validação de dados MQTT (apenas para equipamentos com telemetria)';

-- ========================================================================
-- MIGRATION CONCLUÍDA
-- ========================================================================

-- 📊 Verificar resultado:
SELECT
  codigo,
  nome,
  CASE
    WHEN propriedades_schema IS NOT NULL THEN '✅ Campos Técnicos'
    ELSE '❌ Sem campos'
  END as tem_campos_tecnicos,
  CASE
    WHEN mqtt_schema IS NOT NULL THEN '🔌 MQTT Schema'
    ELSE '❌ Sem MQTT'
  END as tem_mqtt
FROM tipos_equipamentos
WHERE propriedades_schema IS NOT NULL OR mqtt_schema IS NOT NULL
ORDER BY nome;
