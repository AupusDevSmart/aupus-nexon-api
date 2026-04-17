-- Migration: Simplificar Schema do Diagrama Unifilar
-- Data: 2026-01-23
-- Objetivo: Remover complexidade desnecessária e melhorar performance

-- ============================================================================
-- 1. SIMPLIFICAR TABELA equipamentos_conexoes
-- ============================================================================

-- Remover colunas de customização visual (tudo será padrão)
ALTER TABLE equipamentos_conexoes
  DROP COLUMN IF EXISTS tipo_linha,
  DROP COLUMN IF EXISTS cor,
  DROP COLUMN IF EXISTS espessura,
  DROP COLUMN IF EXISTS pontos_intermediarios,
  DROP COLUMN IF EXISTS rotulo,
  DROP COLUMN IF EXISTS ordem;

-- Comentário: Todas as conexões terão visual padrão (linha branca/cinza, 2px, ortogonal)

-- ============================================================================
-- 2. SIMPLIFICAR TABELA equipamentos (campos de diagrama)
-- ============================================================================

-- Remover customizações de dimensões (todos equipamentos terão tamanho padrão)
ALTER TABLE equipamentos
  DROP COLUMN IF EXISTS largura_customizada,
  DROP COLUMN IF EXISTS altura_customizada,
  DROP COLUMN IF EXISTS propriedades;

-- Manter apenas: posicao_x, posicao_y, rotacao, label_position

-- ============================================================================
-- 3. ADICIONAR ÍNDICES PARA PERFORMANCE (se não existirem)
-- ============================================================================

-- Índice para buscar conexões de um diagrama rapidamente
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_conexoes_diagrama_id'
  ) THEN
    CREATE INDEX idx_conexoes_diagrama_id ON equipamentos_conexoes(diagrama_id);
  END IF;
END $$;

-- Índice composto para queries de equipamentos por unidade e diagrama
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_equipamentos_unidade_diagrama'
  ) THEN
    CREATE INDEX idx_equipamentos_unidade_diagrama
      ON equipamentos(unidade_id, diagrama_id)
      WHERE deleted_at IS NULL;
  END IF;
END $$;

-- ============================================================================
-- FIM DA MIGRATION
-- ============================================================================
