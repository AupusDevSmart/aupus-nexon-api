-- ============================================================================
-- NEXON-20 — Permissões e controle de acesso (spec "NexON — Permissões e
-- controle de acesso"). Idempotente; rodar ANTES do deploy da API.
--
-- 1. Papéis novos: analista_automacao e analista_operacao (guard api).
--    O `analista` legado vira Analista de automação; `gerente` conta como
--    Analista de operação (mapeamento no código, src/core/modules/auth/papeis.ts).
-- 2. Proprietário volta a comandar a própria planta e a cadastrar operador
--    (desfaz 2026-09-10_proprietario-monitoramento-only.sql).
-- 3. Vínculo do operador por EQUIPAMENTO (PER-12..21):
--      operador_vinculos             um por operador × proprietário
--      operador_vinculo_equipamentos lista explícita de equipamentos + "Ver R$"
--      operador_vinculo_unidades     "Ver geração" por instalação com usina
--    planta_operadores (vínculo por planta, legado) migra para cá com TODOS os
--    equipamentos raiz da planta: ninguém perde acesso no dia.
-- 4. auditoria_acessos ganha colunas de busca (objeto, resultado, nomes) e vira
--    só-inserção (PER-44): UPDATE/DELETE levantam erro, inclusive para Admin.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS auditoria_acessos_imutavel ON auditoria_acessos;
--   DROP FUNCTION IF EXISTS auditoria_acessos_bloqueia_alteracao();
--   DROP TABLE IF EXISTS operador_vinculo_unidades, operador_vinculo_equipamentos, operador_vinculos;
--   ALTER TABLE auditoria_acessos DROP COLUMN IF EXISTS objeto_tipo, DROP COLUMN IF EXISTS objeto_id,
--     DROP COLUMN IF EXISTS resultado, DROP COLUMN IF EXISTS autor_nome, DROP COLUMN IF EXISTS alvo_nome,
--     DROP COLUMN IF EXISTS rota;
--   (papéis: DELETE FROM roles WHERE name IN ('analista_automacao','analista_operacao') — antes devolver
--    os usuários ao papel antigo em model_has_roles/usuarios.role.)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Papéis
-- ---------------------------------------------------------------------------
INSERT INTO roles (name, guard_name, created_at, updated_at)
SELECT n, 'api', now(), now()
FROM unnest(ARRAY['analista_automacao', 'analista_operacao']) n
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.name = n AND r.guard_name = 'api');

-- Analista de automação: tudo do analista + cadastro técnico completo, IoT,
-- tarifas e gestão de usuários (o que ele cadastra fica no código).
INSERT INTO role_has_permissions (permission_id, role_id)
SELECT p.id, r.id
FROM roles r
JOIN permissions p ON p.name IN (
  'Monitoramento', 'agenda.manage', 'anomalias.manage', 'anomalias.report', 'anomalias.view',
  'dashboard.view', 'equipamentos.acionar_ponto', 'equipamentos.comandar', 'equipamentos.manage',
  'equipamentos.manage_bos', 'equipamentos.manage_pontos', 'equipamentos.view', 'equipamentos.iot_catalog',
  'execucao_os.cancelar', 'execucao_os.executar', 'execucao_os.manage', 'execucao_os.view',
  'manutencao.manage', 'plantas.manage', 'plantas.manage_operadores', 'plantas.view',
  'programacao_os.cancelar', 'programacao_os.manage', 'programacao_os.view', 'recursos.manage',
  'solicitacoes.create', 'tarefas.update_status', 'unidades.manage', 'unidades.view',
  'concessionarias.manage', 'supervisorio.iot_view',
  'usuarios.view', 'usuarios.manage', 'usuarios.create_operador', 'usuarios.create_proprietario',
  'usuarios.create_analista'
)
WHERE r.name = 'analista_automacao' AND r.guard_name = 'api'
ON CONFLICT DO NOTHING;

-- Analista de operação: vê todas as plantas, opera e comanda, configura
-- (técnica e operacional), tarifas; SEM cadastro técnico (plantas, instalações,
-- equipamentos, pontos/BOs, catálogo IoT).
INSERT INTO role_has_permissions (permission_id, role_id)
SELECT p.id, r.id
FROM roles r
JOIN permissions p ON p.name IN (
  'Monitoramento', 'agenda.manage', 'anomalias.manage', 'anomalias.report', 'anomalias.view',
  'dashboard.view', 'equipamentos.acionar_ponto', 'equipamentos.comandar', 'equipamentos.view',
  'execucao_os.cancelar', 'execucao_os.executar', 'execucao_os.manage', 'execucao_os.view',
  'manutencao.manage', 'plantas.manage_operadores', 'plantas.view',
  'programacao_os.cancelar', 'programacao_os.manage', 'programacao_os.view', 'recursos.manage',
  'solicitacoes.create', 'tarefas.update_status', 'unidades.view',
  'concessionarias.manage', 'supervisorio.iot_view',
  'usuarios.view', 'usuarios.manage', 'usuarios.create_operador', 'usuarios.create_proprietario'
)
WHERE r.name = 'analista_operacao' AND r.guard_name = 'api'
ON CONFLICT DO NOTHING;

-- Proprietário: opera e comanda a própria planta e cadastra operador.
INSERT INTO role_has_permissions (permission_id, role_id)
SELECT p.id, r.id
FROM roles r
JOIN permissions p ON p.name IN (
  'equipamentos.acionar_ponto', 'equipamentos.comandar',
  'usuarios.view', 'usuarios.manage', 'usuarios.create_operador', 'plantas.manage_operadores'
)
WHERE r.name = 'proprietario'
ON CONFLICT DO NOTHING;

-- O analista de automação herda TUDO que o `analista` legado tinha (nada se perde).
INSERT INTO role_has_permissions (permission_id, role_id)
SELECT rp.permission_id, na.id
FROM role_has_permissions rp
JOIN roles va ON va.id = rp.role_id AND va.name = 'analista'
JOIN roles na ON na.name = 'analista_automacao' AND na.guard_name = 'api'
ON CONFLICT DO NOTHING;

-- Usuários com o papel `analista` legado passam a Analista de automação.
INSERT INTO model_has_roles (role_id, model_type, model_id)
SELECT na.id, m.model_type, m.model_id
FROM model_has_roles m
JOIN roles va ON va.id = m.role_id AND va.name = 'analista'
JOIN roles na ON na.name = 'analista_automacao' AND na.guard_name = 'api'
ON CONFLICT DO NOTHING;
DELETE FROM model_has_roles m USING roles va
WHERE va.id = m.role_id AND va.name = 'analista';
UPDATE usuarios SET role = 'analista_automacao', updated_at = now()
WHERE role = 'analista' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Vínculos do operador
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operador_vinculos (
  id              char(26)     PRIMARY KEY,
  operador_id     char(26)     NOT NULL REFERENCES usuarios(id),
  proprietario_id char(26)     NOT NULL REFERENCES usuarios(id),
  -- Último dia em que o vínculo vale (inclusive, fuso de São Paulo). NULL = sem validade.
  validade        date,
  criado_por      char(26),
  atualizado_por  char(26),
  removido_por    char(26),
  removido_em     timestamp(0) without time zone,
  created_at      timestamp(0) without time zone NOT NULL DEFAULT now(),
  updated_at      timestamp(0) without time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operador_vinculos_ativo_uq
  ON operador_vinculos (operador_id, proprietario_id) WHERE removido_em IS NULL;
CREATE INDEX IF NOT EXISTS operador_vinculos_operador_idx ON operador_vinculos (operador_id);
CREATE INDEX IF NOT EXISTS operador_vinculos_proprietario_idx ON operador_vinculos (proprietario_id);

CREATE TABLE IF NOT EXISTS operador_vinculo_equipamentos (
  vinculo_id     char(26) NOT NULL REFERENCES operador_vinculos(id) ON DELETE CASCADE,
  equipamento_id char(26) NOT NULL REFERENCES equipamentos(id),
  -- Permissão extra "Ver valores em R$" (pivô, carregador).
  ver_rs         boolean  NOT NULL DEFAULT false,
  created_at     timestamp(0) without time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (vinculo_id, equipamento_id)
);
CREATE INDEX IF NOT EXISTS operador_vinculo_equipamentos_eq_idx ON operador_vinculo_equipamentos (equipamento_id);

CREATE TABLE IF NOT EXISTS operador_vinculo_unidades (
  vinculo_id  char(26) NOT NULL REFERENCES operador_vinculos(id) ON DELETE CASCADE,
  unidade_id  char(26) NOT NULL REFERENCES unidades(id),
  -- Permissão extra "Ver geração" (instalação com usina): análise de geração.
  ver_geracao boolean  NOT NULL DEFAULT false,
  created_at  timestamp(0) without time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (vinculo_id, unidade_id)
);

-- Migra planta_operadores → vínculo com o proprietário da planta e todos os
-- equipamentos raiz dela, com "Ver R$" (mesmo acesso de hoje). Planta sem
-- proprietário não vira vínculo (o vínculo é por dono): conferir antes de rodar
--   SELECT * FROM planta_operadores po JOIN plantas p ON p.id = po.planta_id WHERE p.proprietario_id IS NULL;
INSERT INTO operador_vinculos (id, operador_id, proprietario_id, criado_por, created_at, updated_at)
SELECT substr(md5('vinc' || po.usuario_id || p.proprietario_id), 1, 26), po.usuario_id, p.proprietario_id,
       NULL, COALESCE(min(po.created_at), now()), now()
FROM planta_operadores po
JOIN plantas p ON p.id = po.planta_id AND p.deleted_at IS NULL AND p.proprietario_id IS NOT NULL
JOIN usuarios u ON u.id = po.usuario_id AND u.deleted_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM operador_vinculos v
  WHERE v.operador_id = po.usuario_id AND v.proprietario_id = p.proprietario_id AND v.removido_em IS NULL
)
GROUP BY po.usuario_id, p.proprietario_id;

INSERT INTO operador_vinculo_equipamentos (vinculo_id, equipamento_id, ver_rs)
SELECT v.id, e.id, true
FROM planta_operadores po
JOIN plantas p ON p.id = po.planta_id AND p.deleted_at IS NULL
JOIN operador_vinculos v ON v.operador_id = po.usuario_id AND v.proprietario_id = p.proprietario_id AND v.removido_em IS NULL
JOIN equipamentos e ON e.deleted_at IS NULL AND e.equipamento_pai_id IS NULL
LEFT JOIN unidades un ON un.id = e.unidade_id
WHERE COALESCE(e.planta_id, un.planta_id) = p.id
ON CONFLICT DO NOTHING;

-- Quem tinha a planta inteira continua vendo a geração das usinas dela.
INSERT INTO operador_vinculo_unidades (vinculo_id, unidade_id, ver_geracao)
SELECT DISTINCT v.id, un.id, true
FROM planta_operadores po
JOIN plantas p ON p.id = po.planta_id AND p.deleted_at IS NULL
JOIN operador_vinculos v ON v.operador_id = po.usuario_id AND v.proprietario_id = p.proprietario_id AND v.removido_em IS NULL
JOIN unidades un ON un.planta_id = p.id AND un.deleted_at IS NULL
WHERE EXISTS (
  SELECT 1 FROM equipamentos e JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
  WHERE e.unidade_id = un.id AND e.deleted_at IS NULL AND t.codigo = 'INVERSOR'
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Auditoria: colunas de busca e log imutável
-- ---------------------------------------------------------------------------
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS objeto_tipo varchar(40);
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS objeto_id   varchar(60);
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS resultado   varchar(20) NOT NULL DEFAULT 'ok';
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS autor_nome  varchar(255);
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS alvo_nome   varchar(255);
ALTER TABLE auditoria_acessos ADD COLUMN IF NOT EXISTS rota        varchar(255);
CREATE INDEX IF NOT EXISTS auditoria_acessos_acao_idx   ON auditoria_acessos (acao, created_at DESC);
CREATE INDEX IF NOT EXISTS auditoria_acessos_objeto_idx ON auditoria_acessos (objeto_tipo, objeto_id);
CREATE INDEX IF NOT EXISTS auditoria_acessos_plantas_idx ON auditoria_acessos USING gin (planta_ids);

CREATE OR REPLACE FUNCTION auditoria_acessos_bloqueia_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auditoria_acessos é só-inserção: registro de auditoria não pode ser alterado nem excluído';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auditoria_acessos_imutavel ON auditoria_acessos;
CREATE TRIGGER auditoria_acessos_imutavel
  BEFORE UPDATE OR DELETE ON auditoria_acessos
  FOR EACH ROW EXECUTE FUNCTION auditoria_acessos_bloqueia_alteracao();

COMMIT;
