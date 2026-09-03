-- Proposta comercial na solicitacao de servico.
--
-- Gerado por `prisma migrate diff` e depois editado a mao:
--   * removido o CREATE INDEX em iot_projetos — e tabela do iot_nexon e nao
--     faz parte desta mudanca. O banco e compartilhado com aquele sistema.
--   * IF NOT EXISTS em tudo, para o script poder rodar de novo sem quebrar.
--
-- Totalmente aditivo: nenhum DROP, nenhum ALTER de coluna existente.

-- AlterTable
ALTER TABLE "solicitacoes_servico" ADD COLUMN IF NOT EXISTS "aliquota_percentual" DECIMAL(5,2) DEFAULT 15,
ADD COLUMN IF NOT EXISTS "com_nota_fiscal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "lucro_percentual" DECIMAL(5,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS "total_custo" DECIMAL(14,2),
ADD COLUMN IF NOT EXISTS "total_geral" DECIMAL(14,2),
ADD COLUMN IF NOT EXISTS "total_imposto" DECIMAL(14,2),
ADD COLUMN IF NOT EXISTS "total_lucro" DECIMAL(14,2);

-- CreateTable
CREATE TABLE IF NOT EXISTS "solicitacoes_itens" (
    "id" VARCHAR(26) NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "instrucao_id" VARCHAR(26),
    "recurso_id" CHAR(26),
    "descricao" VARCHAR(200) NOT NULL,
    "unidade" VARCHAR(20),
    "quantidade" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "preco_unitario_original" DECIMAL(14,2),
    "preco_unitario" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ordem" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "solicitacoes_itens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "solicitacoes_subinstrucoes" (
    "id" VARCHAR(26) NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "instrucao_id" VARCHAR(26),
    "descricao" TEXT NOT NULL,
    "tempo_estimado" INTEGER,
    "ordem" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "solicitacoes_subinstrucoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "solicitacoes_outros_custos" (
    "id" VARCHAR(26) NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "descricao" VARCHAR(200) NOT NULL,
    "valor" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "faturamento_direto" BOOLEAN NOT NULL DEFAULT false,
    "ordem" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "solicitacoes_outros_custos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "solicitacoes_itens_solicitacao_id_idx" ON "solicitacoes_itens"("solicitacao_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "solicitacoes_subinstrucoes_solicitacao_id_idx" ON "solicitacoes_subinstrucoes"("solicitacao_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "solicitacoes_outros_custos_solicitacao_id_idx" ON "solicitacoes_outros_custos"("solicitacao_id");


-- AddForeignKey
ALTER TABLE "solicitacoes_itens" ADD CONSTRAINT "solicitacoes_itens_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_subinstrucoes" ADD CONSTRAINT "solicitacoes_subinstrucoes_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_outros_custos" ADD CONSTRAINT "solicitacoes_outros_custos_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;
