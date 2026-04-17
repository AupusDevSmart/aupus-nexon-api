-- AlterTable: Tornar plano_manutencao_id opcional em tarefas
ALTER TABLE "tarefas" ALTER COLUMN "plano_manutencao_id" DROP NOT NULL;

-- CreateTable: Criar tabela de relação N:N entre tarefas e solicitações
CREATE TABLE "tarefas_solicitacoes" (
    "id" VARCHAR(26) NOT NULL DEFAULT gen_random_uuid(),
    "tarefa_id" VARCHAR(26) NOT NULL,
    "solicitacao_id" VARCHAR(36) NOT NULL,
    "ordem" SMALLINT DEFAULT 1,
    "observacoes" TEXT,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),

    CONSTRAINT "tarefas_solicitacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tarefas_solicitacoes_tarefa_id_idx" ON "tarefas_solicitacoes"("tarefa_id");
CREATE INDEX "tarefas_solicitacoes_solicitacao_id_idx" ON "tarefas_solicitacoes"("solicitacao_id");
CREATE UNIQUE INDEX "tarefas_solicitacoes_tarefa_solicitacao_unique" ON "tarefas_solicitacoes"("tarefa_id", "solicitacao_id");

-- AddForeignKey
ALTER TABLE "tarefas_solicitacoes" ADD CONSTRAINT "tarefas_solicitacoes_tarefa_id_fkey"
    FOREIGN KEY ("tarefa_id") REFERENCES "tarefas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tarefas_solicitacoes" ADD CONSTRAINT "tarefas_solicitacoes_solicitacao_id_fkey"
    FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex: Adicionar índice para filtrar tarefas sem plano
CREATE INDEX "tarefas_plano_null_idx" ON "tarefas"("plano_manutencao_id") WHERE "plano_manutencao_id" IS NULL;