-- ================================================
-- Migration: Remove CHECK constraint da coluna role
-- Data: 2025-12-09
-- Objetivo: Permitir que a coluna "role" aceite TODAS as roles do sistema Spatie
-- ================================================

-- 1. Remover a constraint CHECK que limita role a apenas 4 valores
ALTER TABLE usuarios
DROP CONSTRAINT IF EXISTS usuarios_role_check;

-- 2. Documentação
-- A coluna "role" agora aceita qualquer valor VARCHAR(255)
-- Valores permitidos agora incluem todas as roles do Spatie:
--   - super_admin
--   - admin
--   - gerente
--   - vendedor
--   - consultor
--   - operador
--   - cliente
--   - etc.

-- 3. Verificar que a constraint foi removida
-- SELECT constraint_name, constraint_type
-- FROM information_schema.table_constraints
-- WHERE table_name = 'usuarios' AND constraint_name = 'usuarios_role_check';
-- (Deve retornar 0 linhas)

COMMENT ON COLUMN usuarios.role IS 'Role do usuário (legacy). Sistema Spatie usa model_has_roles. Aceita qualquer valor sem restrições.';
