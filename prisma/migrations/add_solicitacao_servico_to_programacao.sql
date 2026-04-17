-- Adicionar campo solicitacao_servico_id à tabela programacoes_os
ALTER TABLE "programacoes_os"
ADD COLUMN IF NOT EXISTS "solicitacao_servico_id" CHAR(26);

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS "idx_programacoes_os_solicitacao_servico_id"
ON "programacoes_os"("solicitacao_servico_id");

-- Adicionar constraint de foreign key
ALTER TABLE "programacoes_os"
ADD CONSTRAINT "fk_programacoes_os_solicitacao_servico"
FOREIGN KEY ("solicitacao_servico_id")
REFERENCES "solicitacoes_servico"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
