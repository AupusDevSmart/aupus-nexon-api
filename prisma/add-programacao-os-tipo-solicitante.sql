-- Adicionar 'programacao_os' ao enum tipo_solicitante
ALTER TYPE tipo_solicitante ADD VALUE IF NOT EXISTS 'programacao_os';
