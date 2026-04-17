-- Adicionar campos unidade_id e proprietario_id na tabela solicitacoes_servico
ALTER TABLE solicitacoes_servico
ADD COLUMN IF NOT EXISTS unidade_id CHAR(26),
ADD COLUMN IF NOT EXISTS proprietario_id CHAR(26);

-- Adicionar índices para os novos campos
CREATE INDEX IF NOT EXISTS idx_solicitacoes_servico_unidade_id ON solicitacoes_servico(unidade_id);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_servico_proprietario_id ON solicitacoes_servico(proprietario_id);

-- Adicionar chaves estrangeiras (se as tabelas existirem)
DO $$
BEGIN
    -- Adicionar FK para unidade_id se a tabela unidades existir
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'unidades') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                       WHERE constraint_name = 'fk_solicitacoes_servico_unidade'
                       AND table_name = 'solicitacoes_servico') THEN
            ALTER TABLE solicitacoes_servico
            ADD CONSTRAINT fk_solicitacoes_servico_unidade
            FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE SET NULL;
        END IF;
    END IF;

    -- Adicionar FK para proprietario_id se a tabela usuarios existir
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'usuarios') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                       WHERE constraint_name = 'fk_solicitacoes_servico_proprietario'
                       AND table_name = 'solicitacoes_servico') THEN
            ALTER TABLE solicitacoes_servico
            ADD CONSTRAINT fk_solicitacoes_servico_proprietario
            FOREIGN KEY (proprietario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
        END IF;
    END IF;
END $$;