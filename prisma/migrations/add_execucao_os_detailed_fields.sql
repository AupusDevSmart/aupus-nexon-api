-- Migration: Adicionar campos detalhados para finalização de execução de OS
-- Data: 2025-12-11
-- Descrição: Adiciona campos para atividades, segurança, procedimentos e custos adicionais

-- Adicionar campos para atividades e procedimentos
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS atividades_realizadas TEXT;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS checklist_concluido SMALLINT CHECK (checklist_concluido >= 0 AND checklist_concluido <= 100);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS procedimentos_seguidos TEXT;

-- Adicionar campos para segurança e EPIs
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS equipamentos_seguranca TEXT;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS incidentes_seguranca TEXT;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS medidas_seguranca_adicionais TEXT;

-- Adicionar campo para custos adicionais
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS custos_adicionais DECIMAL(12, 2) CHECK (custos_adicionais >= 0);

-- Comentários para documentação
COMMENT ON COLUMN ordens_servico.atividades_realizadas IS 'Descrição detalhada das atividades executadas durante a OS';
COMMENT ON COLUMN ordens_servico.checklist_concluido IS 'Percentual de conclusão do checklist (0-100)';
COMMENT ON COLUMN ordens_servico.procedimentos_seguidos IS 'Procedimentos seguidos durante a execução';
COMMENT ON COLUMN ordens_servico.equipamentos_seguranca IS 'EPIs e equipamentos de segurança utilizados';
COMMENT ON COLUMN ordens_servico.incidentes_seguranca IS 'Incidentes de segurança ocorridos durante a execução';
COMMENT ON COLUMN ordens_servico.medidas_seguranca_adicionais IS 'Medidas de segurança adicionais adotadas';
COMMENT ON COLUMN ordens_servico.custos_adicionais IS 'Custos adicionais não planejados incorridos durante a execução (R$)';
