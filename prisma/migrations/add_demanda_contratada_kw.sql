-- Migration: Adicionar campo demanda_contratada_kw na tabela unidades
-- Data: 2025-01-XX
-- Descrição: Campo para armazenar a demanda contratada em kW da unidade

ALTER TABLE unidades
ADD COLUMN IF NOT EXISTS demanda_contratada_kw DECIMAL(10, 2) CHECK (demanda_contratada_kw >= 0);

COMMENT ON COLUMN unidades.demanda_contratada_kw IS 'Demanda contratada da unidade em kW (valor usado no gráfico de demanda)';
