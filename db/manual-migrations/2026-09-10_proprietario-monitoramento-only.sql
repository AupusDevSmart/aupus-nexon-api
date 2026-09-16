-- ============================================================================
-- Cliente (role `proprietario`) = SÓ MONITORAMENTO por enquanto.
-- Remove do papel as permissões de ESCRITA/COMANDO do NexON — o cliente já perdeu
-- o acesso pela UI (menu Cadastros escondido + rotas barradas), isto fecha a API.
-- Mantém as de LEITURA (dashboard.view, equipamentos.view, plantas.view,
-- unidades.view, usuarios.view) que o COA/sinóptico usam.
-- NÃO mexe nas permissões de domínio do Service (execucao_os/manutencao/anomalias/
-- programacao_os/agenda/recursos/tarefas/solicitacoes) — NexON não as consome e o
-- Service roda em banco separado (aupus_service).
--
-- ⚠️ Sessões de cliente já logadas só perdem as permissões no próximo refresh do
-- JWT (o token carrega as permissões do login). Novos logins já vêm reduzidos.
--
-- ROLLBACK (readicionar): trocar DELETE por INSERT ... ON CONFLICT DO NOTHING com
-- o mesmo SELECT (mesma lista de nomes).
-- ============================================================================

DELETE FROM role_has_permissions rhp
USING roles r, permissions p
WHERE rhp.role_id = r.id
  AND rhp.permission_id = p.id
  AND r.name = 'proprietario'
  AND p.name IN (
    'equipamentos.manage',
    'equipamentos.manage_bos',
    'equipamentos.manage_pontos',
    'equipamentos.comandar',
    'equipamentos.acionar_ponto',
    'plantas.manage',
    'plantas.manage_operadores',
    'unidades.manage',
    'usuarios.create_operador',
    'usuarios.manage_created'
  );
