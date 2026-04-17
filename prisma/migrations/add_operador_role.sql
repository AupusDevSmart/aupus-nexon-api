-- ============================================================================
-- Migration: Adicionar Role OPERADOR e Sistema de Created By
-- Data: 2025-01-XX
-- Descrição: Adiciona novo tipo de usuário OPERADOR e campo created_by
-- ============================================================================

-- 1. Adicionar coluna created_by na tabela usuarios
ALTER TABLE usuarios
ADD COLUMN IF NOT EXISTS created_by CHAR(26);

-- 2. Criar índice para performance
CREATE INDEX IF NOT EXISTS idx_usuarios_created_by ON usuarios(created_by);

-- 3. Adicionar foreign key constraint
ALTER TABLE usuarios
ADD CONSTRAINT fk_usuarios_created_by
FOREIGN KEY (created_by) REFERENCES usuarios(id)
ON DELETE SET NULL
ON UPDATE NO ACTION;

-- 4. Inserir role OPERADOR (se não existir)
INSERT INTO roles (name, guard_name, created_at, updated_at)
SELECT 'operador', 'api', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE name = 'operador' AND guard_name = 'api'
);

-- 5. Criar permissões específicas para OPERADOR (acesso limitado)
-- Operador terá acesso apenas a monitoramento básico e equipamentos

INSERT INTO permissions (name, display_name, description, guard_name, created_at, updated_at)
SELECT 'Dashboard', 'Dashboard', 'Visualizar dashboard básico', 'api', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE name = 'Dashboard' AND guard_name = 'api');

INSERT INTO permissions (name, display_name, description, guard_name, created_at, updated_at)
SELECT 'MonitoramentoConsumo', 'Monitoramento de Consumo', 'Monitorar consumo de energia', 'api', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE name = 'MonitoramentoConsumo' AND guard_name = 'api');

INSERT INTO permissions (name, display_name, description, guard_name, created_at, updated_at)
SELECT 'GeracaoEnergia', 'Geração de Energia', 'Visualizar geração de energia', 'api', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE name = 'GeracaoEnergia' AND guard_name = 'api');

INSERT INTO permissions (name, display_name, description, guard_name, created_at, updated_at)
SELECT 'Equipamentos', 'Equipamentos', 'Visualizar equipamentos', 'api', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE name = 'Equipamentos' AND guard_name = 'api');

-- 6. Associar permissões ao role OPERADOR
INSERT INTO role_has_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1),
  (SELECT id FROM permissions WHERE name = 'Dashboard' AND guard_name = 'api' LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM role_has_permissions
  WHERE role_id = (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1)
  AND permission_id = (SELECT id FROM permissions WHERE name = 'Dashboard' AND guard_name = 'api' LIMIT 1)
);

INSERT INTO role_has_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1),
  (SELECT id FROM permissions WHERE name = 'MonitoramentoConsumo' AND guard_name = 'api' LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM role_has_permissions
  WHERE role_id = (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1)
  AND permission_id = (SELECT id FROM permissions WHERE name = 'MonitoramentoConsumo' AND guard_name = 'api' LIMIT 1)
);

INSERT INTO role_has_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1),
  (SELECT id FROM permissions WHERE name = 'GeracaoEnergia' AND guard_name = 'api' LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM role_has_permissions
  WHERE role_id = (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1)
  AND permission_id = (SELECT id FROM permissions WHERE name = 'GeracaoEnergia' AND guard_name = 'api' LIMIT 1)
);

INSERT INTO role_has_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1),
  (SELECT id FROM permissions WHERE name = 'Equipamentos' AND guard_name = 'api' LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM role_has_permissions
  WHERE role_id = (SELECT id FROM roles WHERE name = 'operador' AND guard_name = 'api' LIMIT 1)
  AND permission_id = (SELECT id FROM permissions WHERE name = 'Equipamentos' AND guard_name = 'api' LIMIT 1)
);

-- 7. Verificação
SELECT
  r.name as role_name,
  COUNT(rhp.permission_id) as total_permissions
FROM roles r
LEFT JOIN role_has_permissions rhp ON r.id = rhp.role_id
WHERE r.name = 'operador'
GROUP BY r.id, r.name;

-- 8. Mostrar permissões do operador
SELECT
  r.name as role_name,
  p.name as permission_name,
  p.display_name
FROM roles r
JOIN role_has_permissions rhp ON r.id = rhp.role_id
JOIN permissions p ON rhp.permission_id = p.id
WHERE r.name = 'operador'
ORDER BY p.name;

COMMIT;
