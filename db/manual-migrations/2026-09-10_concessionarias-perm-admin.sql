-- ============================================================================
-- Concessionárias: fechar a escrita (tarifa é dado GLOBAL, valia p/ todos os
-- clientes e o controller estava SEM @Permissions — qualquer logado editava).
-- Agora as escritas exigem `concessionarias.manage`. Nenhuma role tinha essa
-- permissão, então CONCEDE a admin + super_admin (senão trancaria os admins).
-- Leitura (GET) fica aberta. Sessões de admin já logadas só ganham a permissão
-- no próximo refresh do token (o JWT carrega as permissões do login).
--
-- ROLLBACK:
--   DELETE FROM role_has_permissions rhp
--   USING roles r, permissions p
--   WHERE rhp.role_id=r.id AND rhp.permission_id=p.id
--     AND r.name IN ('admin','super_admin') AND p.name='concessionarias.manage';
-- ============================================================================

INSERT INTO role_has_permissions (permission_id, role_id)
SELECT p.id, r.id
FROM permissions p
JOIN roles r ON r.name IN ('admin', 'super_admin')
WHERE p.name = 'concessionarias.manage'
ON CONFLICT DO NOTHING;
