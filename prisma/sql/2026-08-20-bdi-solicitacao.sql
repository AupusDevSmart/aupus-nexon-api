-- BDI (Beneficios e Despesas Indiretas) na solicitacao de servico.
--
-- Gerado por prisma migrate diff, com o CREATE INDEX em iot_projetos removido
-- a mao: tabela do iot_nexon, fora desta mudanca, banco compartilhado.
-- Aditivo e idempotente.

-- AlterTable
ALTER TABLE "solicitacoes_servico" ADD COLUMN IF NOT EXISTS "bdi_administracao_central" DECIMAL(6,3) DEFAULT 5.00,
ADD COLUMN IF NOT EXISTS "bdi_cofins" DECIMAL(6,3) DEFAULT 3.00,
ADD COLUMN IF NOT EXISTS "bdi_cprb" DECIMAL(6,3) DEFAULT 4.50,
ADD COLUMN IF NOT EXISTS "bdi_despesas_financeiras" DECIMAL(6,3) DEFAULT 0.50,
ADD COLUMN IF NOT EXISTS "bdi_issqn" DECIMAL(6,3) DEFAULT 6.50,
ADD COLUMN IF NOT EXISTS "bdi_lucro" DECIMAL(6,3) DEFAULT 5.00,
ADD COLUMN IF NOT EXISTS "bdi_percentual" DECIMAL(6,3),
ADD COLUMN IF NOT EXISTS "bdi_pis" DECIMAL(6,3) DEFAULT 0.65,
ADD COLUMN IF NOT EXISTS "bdi_regime" VARCHAR(20) NOT NULL DEFAULT 'SEM_REIDI',
ADD COLUMN IF NOT EXISTS "bdi_seguro_garantia" DECIMAL(6,3) DEFAULT 0.50,
ADD COLUMN IF NOT EXISTS "bdi_taxa_risco" DECIMAL(6,3) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS "total_bdi" DECIMAL(14,2);
