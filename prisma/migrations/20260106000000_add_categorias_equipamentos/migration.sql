-- ========================================================================
-- MIGRATION: Adicionar hierarquia Categorias -> Modelos -> Equipamentos
-- Data: 2026-01-06
-- Descrição: Criar categorias de equipamentos e vincular modelos existentes
-- ========================================================================

-- ✅ STEP 1: Criar tabela categorias_equipamentos (SIMPLIFICADA)
CREATE TABLE "categorias_equipamentos" (
  "id" CHAR(26) NOT NULL,
  "nome" VARCHAR(100) NOT NULL,

  CONSTRAINT "categorias_equipamentos_pkey" PRIMARY KEY ("id")
);

-- ✅ STEP 2: Inserir 17 categorias padrão
INSERT INTO "categorias_equipamentos" (id, nome) VALUES
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Transformador de Potência'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Transformador de Potencial (TP)'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Transformador de Corrente (TC)'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Banco Capacitor'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Disjuntor MT'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Disjuntor BT'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Chave'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Pivô'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Motor Elétrico'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Módulos PV'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Power Meter (PM)'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Inversor PV'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Medidor SSU'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Relê Proteção'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'Inversor Frequência'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'SoftStarter'),
  (SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 26), 'RTU');

-- ✅ STEP 3: Adicionar novos campos em tipos_equipamentos
ALTER TABLE "tipos_equipamentos"
  ADD COLUMN "categoria_id" CHAR(26),
  ADD COLUMN "fabricante" VARCHAR(100);

-- ✅ STEP 4: Mapear tipos existentes para categorias (BASEADO EM DADOS REAIS)
DO $$
DECLARE
  cat_power_meter_id CHAR(26);
  cat_inversor_pv_id CHAR(26);
  cat_pivo_id CHAR(26);
  cat_transformador_id CHAR(26);
  cat_disjuntor_bt_id CHAR(26);
  cat_chave_id CHAR(26);
  cat_motor_id CHAR(26);
  cat_modulos_pv_id CHAR(26);
BEGIN
  -- Buscar IDs das categorias
  SELECT id INTO cat_power_meter_id FROM categorias_equipamentos WHERE nome = 'Power Meter (PM)';
  SELECT id INTO cat_inversor_pv_id FROM categorias_equipamentos WHERE nome = 'Inversor PV';
  SELECT id INTO cat_pivo_id FROM categorias_equipamentos WHERE nome = 'Pivô';
  SELECT id INTO cat_transformador_id FROM categorias_equipamentos WHERE nome = 'Transformador de Potência';
  SELECT id INTO cat_disjuntor_bt_id FROM categorias_equipamentos WHERE nome = 'Disjuntor BT';
  SELECT id INTO cat_chave_id FROM categorias_equipamentos WHERE nome = 'Chave';
  SELECT id INTO cat_motor_id FROM categorias_equipamentos WHERE nome = 'Motor Elétrico';
  SELECT id INTO cat_modulos_pv_id FROM categorias_equipamentos WHERE nome = 'Módulos PV';

  -- ⚡ TIPOS COM MQTT ATIVO - PRESERVAR OBRIGATORIAMENTE
  -- METER_M160 -> Power Meter (PM)
  UPDATE tipos_equipamentos
  SET categoria_id = cat_power_meter_id, fabricante = 'Kron'
  WHERE codigo = 'METER_M160';

  -- INVERSOR -> Inversor PV
  UPDATE tipos_equipamentos
  SET categoria_id = cat_inversor_pv_id, fabricante = 'Growatt'
  WHERE codigo = 'INVERSOR';

  -- PIVO -> Pivô
  UPDATE tipos_equipamentos
  SET categoria_id = cat_pivo_id, fabricante = 'Valley'
  WHERE codigo = 'PIVO';

  -- 🔧 OUTROS TIPOS EM USO (sem MQTT, mas têm equipamentos)
  -- TRANSFORMADOR -> Transformador de Potência
  UPDATE tipos_equipamentos
  SET categoria_id = cat_transformador_id, fabricante = 'Genérico'
  WHERE codigo = 'TRANSFORMADOR';

  -- DISJUNTOR -> Disjuntor BT
  UPDATE tipos_equipamentos
  SET categoria_id = cat_disjuntor_bt_id, fabricante = 'Schneider'
  WHERE codigo = 'DISJUNTOR';

  -- CHAVE_ABERTA, CHAVE_FUSIVEL -> Chave
  UPDATE tipos_equipamentos
  SET categoria_id = cat_chave_id, fabricante = 'Genérico'
  WHERE codigo IN ('CHAVE_ABERTA', 'CHAVE_FUSIVEL');

  -- MOTOR -> Motor Elétrico
  UPDATE tipos_equipamentos
  SET categoria_id = cat_motor_id, fabricante = 'WEG'
  WHERE codigo = 'MOTOR';

  -- PAINEL_SOLAR -> Módulos PV
  UPDATE tipos_equipamentos
  SET categoria_id = cat_modulos_pv_id, fabricante = 'Canadian Solar'
  WHERE codigo = 'PAINEL_SOLAR';

  -- IMS_A966, A966 -> RTU (Gateway IoT)
  UPDATE tipos_equipamentos
  SET categoria_id = (SELECT id FROM categorias_equipamentos WHERE nome = 'RTU'),
      fabricante = 'Kron'
  WHERE codigo IN ('IMS_A966', 'A966');

  -- BARRAMENTO -> Manter como Genérico (sem categoria definida)
  UPDATE tipos_equipamentos
  SET categoria_id = (SELECT id FROM categorias_equipamentos WHERE nome = 'RTU' LIMIT 1),
      fabricante = 'Genérico'
  WHERE codigo = 'BARRAMENTO';

  -- ⚠️ TIPOS NÃO MAPEADOS: Definir categoria genérica
  UPDATE tipos_equipamentos
  SET categoria_id = cat_power_meter_id, fabricante = 'Genérico'
  WHERE categoria_id IS NULL;

END $$;

-- ✅ STEP 5: Tornar campos obrigatórios
ALTER TABLE "tipos_equipamentos"
  ALTER COLUMN "categoria_id" SET NOT NULL,
  ALTER COLUMN "fabricante" SET NOT NULL;

-- ✅ STEP 6: Adicionar FK e índices
ALTER TABLE "tipos_equipamentos"
  ADD CONSTRAINT "tipos_equipamentos_categoria_id_fkey"
  FOREIGN KEY ("categoria_id") REFERENCES "categorias_equipamentos"("id")
  ON DELETE RESTRICT;

CREATE INDEX "tipos_equipamentos_categoria_id_idx" ON "tipos_equipamentos"("categoria_id");
CREATE INDEX "tipos_equipamentos_fabricante_idx" ON "tipos_equipamentos"("fabricante");

-- ✅ STEP 7: Adicionar campo fabricante_custom em equipamentos
ALTER TABLE "equipamentos"
  ADD COLUMN "fabricante_custom" VARCHAR(255);

-- ✅ STEP 8: Migrar fabricantes customizados
-- Se fabricante do equipamento difere do modelo, copiar para fabricante_custom
UPDATE "equipamentos" e
SET "fabricante_custom" = e.fabricante
FROM tipos_equipamentos t
WHERE e.tipo_equipamento_id = t.id
  AND e.fabricante IS NOT NULL
  AND e.fabricante != t.fabricante;

-- ========================================================================
-- MIGRATION CONCLUÍDA
-- ========================================================================

-- ⚠️ PRÓXIMOS PASSOS (EXECUTAR MANUALMENTE APÓS VALIDAÇÃO):
-- 1. Validar que todos equipamentos com MQTT continuam funcionando
-- 2. Validar que tipos_equipamentos.fabricante está correto
-- 3. Validar que equipamentos.fabricante_custom foi preenchido corretamente
-- 4. Após validação completa, considerar remover coluna 'categoria' de tipos_equipamentos:
--    ALTER TABLE "tipos_equipamentos" DROP COLUMN "categoria";
-- 5. Considerar remover coluna 'fabricante' de equipamentos (usar apenas fabricante_custom):
--    ALTER TABLE "equipamentos" DROP COLUMN "fabricante";
