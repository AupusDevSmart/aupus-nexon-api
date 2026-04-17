-- Migration: Add PHF tracking and energy calculation fields
-- Date: 2025-11-13
-- Description: Adds columns for PHF (Period Hour Forward) tracking, energy calculation,
--              power demand, time classification, and duplicate prevention

-- =====================================================
-- STEP 1: Add new columns to equipamentos_dados
-- =====================================================

-- PHF tracking columns
ALTER TABLE equipamentos_dados
  ADD COLUMN IF NOT EXISTS phf_atual DECIMAL(12, 3),
  ADD COLUMN IF NOT EXISTS phf_anterior DECIMAL(12, 3);

-- Energy calculation column
ALTER TABLE equipamentos_dados
  ADD COLUMN IF NOT EXISTS energia_kwh DECIMAL(10, 3);

-- Power demand column (for demand calculation)
ALTER TABLE equipamentos_dados
  ADD COLUMN IF NOT EXISTS potencia_ativa_kw DECIMAL(10, 3);

-- Time classification column (PONTA, FORA_PONTA, HORARIO_RESERVADO)
ALTER TABLE equipamentos_dados
  ADD COLUMN IF NOT EXISTS tipo_horario VARCHAR(20);

-- Quality already exists, but ensure it's nullable
-- ALTER TABLE equipamentos_dados ALTER COLUMN qualidade DROP NOT NULL IF EXISTS;

-- =====================================================
-- STEP 2: Create UNIQUE constraint to prevent duplicates
-- =====================================================
-- This prevents multiple backends from inserting duplicate data

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uk_equipamento_timestamp'
    ) THEN
        ALTER TABLE equipamentos_dados
          ADD CONSTRAINT uk_equipamento_timestamp
          UNIQUE (equipamento_id, timestamp_dados);
    END IF;
END$$;

-- =====================================================
-- STEP 3: Create performance indexes
-- =====================================================

-- Index for period queries (timestamp range)
CREATE INDEX IF NOT EXISTS idx_equipamentos_dados_periodo
  ON equipamentos_dados(equipamento_id, timestamp_dados, energia_kwh)
  WHERE energia_kwh IS NOT NULL;

-- Index for demand calculation (max power)
CREATE INDEX IF NOT EXISTS idx_equipamentos_dados_potencia
  ON equipamentos_dados(equipamento_id, potencia_ativa_kw)
  WHERE potencia_ativa_kw IS NOT NULL;

-- Index for time classification queries
CREATE INDEX IF NOT EXISTS idx_equipamentos_dados_tipo_horario
  ON equipamentos_dados(equipamento_id, tipo_horario, timestamp_dados)
  WHERE tipo_horario IS NOT NULL;

-- =====================================================
-- STEP 4: Add comments for documentation
-- =====================================================

COMMENT ON COLUMN equipamentos_dados.phf_atual IS 'Period Hour Forward - valor acumulado de energia (kWh) da leitura atual';
COMMENT ON COLUMN equipamentos_dados.phf_anterior IS 'PHF da leitura anterior para cálculo de delta';
COMMENT ON COLUMN equipamentos_dados.energia_kwh IS 'Energia consumida no período (phf_atual - phf_anterior)';
COMMENT ON COLUMN equipamentos_dados.potencia_ativa_kw IS 'Potência ativa total (Pa+Pb+Pc) em kW para cálculo de demanda';
COMMENT ON COLUMN equipamentos_dados.tipo_horario IS 'Classificação tarifária: PONTA, FORA_PONTA, HORARIO_RESERVADO';
COMMENT ON COLUMN equipamentos_dados.qualidade IS 'Qualidade da leitura: OK, PRIMEIRA_LEITURA, SUSPEITO, PHF_RESET';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
