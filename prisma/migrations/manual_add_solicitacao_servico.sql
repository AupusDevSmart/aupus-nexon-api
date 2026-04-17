-- =============================================
-- MIGRATION MANUAL: ADICIONAR SOLICITAÇÃO DE SERVIÇO
-- =============================================

-- Adicionar novo valor ao enum OrigemOS
ALTER TYPE "origem_os" ADD VALUE IF NOT EXISTS 'SOLICITACAO_SERVICO';

-- Criar enum StatusSolicitacaoServico
CREATE TYPE "StatusSolicitacaoServico" AS ENUM (
  'RASCUNHO',
  'AGUARDANDO',
  'EM_ANALISE',
  'APROVADA',
  'OS_GERADA',
  'EM_EXECUCAO',
  'CONCLUIDA',
  'CANCELADA',
  'REJEITADA'
);

-- Criar enum TipoSolicitacaoServico
CREATE TYPE "TipoSolicitacaoServico" AS ENUM (
  'INSTALACAO',
  'MELHORIA',
  'PREVENTIVA',
  'ADAPTACAO',
  'INSPECAO',
  'CALIBRACAO',
  'LIMPEZA',
  'TREINAMENTO',
  'OUTROS'
);

-- Criar enum PrioridadeSolicitacao
CREATE TYPE "PrioridadeSolicitacao" AS ENUM (
  'BAIXA',
  'MEDIA',
  'ALTA',
  'URGENTE'
);

-- Criar enum OrigemSolicitacao
CREATE TYPE "OrigemSolicitacao" AS ENUM (
  'OPERADOR',
  'SISTEMA',
  'PREVENTIVA',
  'MELHORIA',
  'AUDITORIA'
);

-- Criar tabela solicitacoes_servico
CREATE TABLE "solicitacoes_servico" (
  "id" CHAR(26) NOT NULL DEFAULT gen_random_uuid()::text,
  "numero" VARCHAR(50) NOT NULL,
  "titulo" VARCHAR(255) NOT NULL,
  "descricao" TEXT NOT NULL,
  "tipo" "TipoSolicitacaoServico" NOT NULL,
  "status" "StatusSolicitacaoServico" NOT NULL DEFAULT 'RASCUNHO',
  "prioridade" "PrioridadeSolicitacao" NOT NULL DEFAULT 'MEDIA',
  "origem" "OrigemSolicitacao" NOT NULL DEFAULT 'OPERADOR',
  "planta_id" CHAR(26),
  "equipamento_id" CHAR(26),
  "local" VARCHAR(255) NOT NULL,
  "area" VARCHAR(255),
  "data_solicitacao" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "data_necessidade" TIMESTAMP,
  "prazo_execucao" INTEGER,
  "data_prevista_inicio" TIMESTAMP,
  "data_prevista_fim" TIMESTAMP,
  "justificativa" TEXT NOT NULL,
  "beneficios_esperados" TEXT,
  "riscos_nao_execucao" TEXT,
  "tempo_estimado" DECIMAL(5,2),
  "custo_estimado" DECIMAL(12,2),
  "materiais_necessarios" TEXT,
  "ferramentas_necessarias" TEXT,
  "mao_obra_necessaria" TEXT,
  "solicitante_id" CHAR(26),
  "solicitante_nome" VARCHAR(255) NOT NULL,
  "departamento" VARCHAR(100),
  "contato" VARCHAR(100),
  "analisado_por_id" CHAR(26),
  "analisado_por_nome" VARCHAR(255),
  "data_analise" TIMESTAMP,
  "parecer_tecnico" TEXT,
  "observacoes_analise" TEXT,
  "aprovado_por_id" CHAR(26),
  "aprovado_por_nome" VARCHAR(255),
  "data_aprovacao" TIMESTAMP,
  "observacoes_aprovacao" TEXT,
  "motivo_rejeicao" TEXT,
  "sugestoes_alternativas" TEXT,
  "motivo_cancelamento" TEXT,
  "cancelado_por_id" CHAR(26),
  "cancelado_por_nome" VARCHAR(255),
  "data_cancelamento" TIMESTAMP,
  "programacao_os_id" CHAR(26) UNIQUE,
  "ordem_servico_id" VARCHAR(50),
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP,

  CONSTRAINT "solicitacoes_servico_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "solicitacoes_servico_numero_key" UNIQUE ("numero")
);

-- Criar índices
CREATE INDEX "solicitacoes_servico_numero_idx" ON "solicitacoes_servico"("numero");
CREATE INDEX "solicitacoes_servico_status_idx" ON "solicitacoes_servico"("status");
CREATE INDEX "solicitacoes_servico_tipo_idx" ON "solicitacoes_servico"("tipo");
CREATE INDEX "solicitacoes_servico_prioridade_idx" ON "solicitacoes_servico"("prioridade");
CREATE INDEX "solicitacoes_servico_data_solicitacao_idx" ON "solicitacoes_servico"("data_solicitacao");
CREATE INDEX "solicitacoes_servico_planta_id_idx" ON "solicitacoes_servico"("planta_id");
CREATE INDEX "solicitacoes_servico_equipamento_id_idx" ON "solicitacoes_servico"("equipamento_id");
CREATE INDEX "solicitacoes_servico_solicitante_id_idx" ON "solicitacoes_servico"("solicitante_id");
CREATE INDEX "solicitacoes_servico_deleted_at_idx" ON "solicitacoes_servico"("deleted_at");

-- Criar tabela historico_solicitacao_servico
CREATE TABLE "historico_solicitacao_servico" (
  "id" CHAR(26) NOT NULL DEFAULT gen_random_uuid()::text,
  "solicitacao_id" CHAR(26) NOT NULL,
  "acao" VARCHAR(255) NOT NULL,
  "usuario_id" CHAR(26),
  "usuario_nome" VARCHAR(255) NOT NULL,
  "data" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status_anterior" "StatusSolicitacaoServico",
  "status_novo" "StatusSolicitacaoServico",
  "observacoes" TEXT,
  "dados_extras" JSONB,

  CONSTRAINT "historico_solicitacao_servico_pkey" PRIMARY KEY ("id")
);

-- Criar índices
CREATE INDEX "historico_solicitacao_servico_solicitacao_id_idx" ON "historico_solicitacao_servico"("solicitacao_id");
CREATE INDEX "historico_solicitacao_servico_data_idx" ON "historico_solicitacao_servico"("data");

-- Criar tabela anexos_solicitacao_servico
CREATE TABLE "anexos_solicitacao_servico" (
  "id" CHAR(26) NOT NULL DEFAULT gen_random_uuid()::text,
  "solicitacao_id" CHAR(26) NOT NULL,
  "nome" VARCHAR(255) NOT NULL,
  "nome_original" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "tamanho" INTEGER NOT NULL,
  "caminho" TEXT NOT NULL,
  "descricao" TEXT,
  "tipo_documento" VARCHAR(50),
  "uploaded_por_id" CHAR(26),
  "uploaded_por_nome" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "anexos_solicitacao_servico_pkey" PRIMARY KEY ("id")
);

-- Criar índice
CREATE INDEX "anexos_solicitacao_servico_solicitacao_id_idx" ON "anexos_solicitacao_servico"("solicitacao_id");

-- Criar tabela comentarios_solicitacao_servico
CREATE TABLE "comentarios_solicitacao_servico" (
  "id" CHAR(26) NOT NULL DEFAULT gen_random_uuid()::text,
  "solicitacao_id" CHAR(26) NOT NULL,
  "comentario" TEXT NOT NULL,
  "usuario_id" CHAR(26),
  "usuario_nome" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "comentarios_solicitacao_servico_pkey" PRIMARY KEY ("id")
);

-- Criar índices
CREATE INDEX "comentarios_solicitacao_servico_solicitacao_id_idx" ON "comentarios_solicitacao_servico"("solicitacao_id");
CREATE INDEX "comentarios_solicitacao_servico_created_at_idx" ON "comentarios_solicitacao_servico"("created_at");

-- Adicionar foreign keys
ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_planta_id_fkey"
  FOREIGN KEY ("planta_id") REFERENCES "plantas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_equipamento_id_fkey"
  FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_solicitante_id_fkey"
  FOREIGN KEY ("solicitante_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_analisado_por_id_fkey"
  FOREIGN KEY ("analisado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_aprovado_por_id_fkey"
  FOREIGN KEY ("aprovado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_cancelado_por_id_fkey"
  FOREIGN KEY ("cancelado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitacoes_servico" ADD CONSTRAINT "solicitacoes_servico_programacao_os_id_fkey"
  FOREIGN KEY ("programacao_os_id") REFERENCES "programacoes_os"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "historico_solicitacao_servico" ADD CONSTRAINT "historico_solicitacao_servico_solicitacao_id_fkey"
  FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "anexos_solicitacao_servico" ADD CONSTRAINT "anexos_solicitacao_servico_solicitacao_id_fkey"
  FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comentarios_solicitacao_servico" ADD CONSTRAINT "comentarios_solicitacao_servico_solicitacao_id_fkey"
  FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes_servico"("id") ON DELETE CASCADE ON UPDATE CASCADE;