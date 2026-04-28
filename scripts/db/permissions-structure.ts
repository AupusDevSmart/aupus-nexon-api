/**
 * ESTRUTURA DE PERMISSÕES MODERNA - AUPUS NEXON
 *
 * Padrão: recurso.acao
 * - Todas em minúsculas
 * - Separadas por ponto (.)
 * - Ações: view, create, edit, delete, manage
 */

export const PERMISSIONS_STRUCTURE = {
  // ==============================================================================
  // DASHBOARD & PAINEL
  // ==============================================================================
  dashboard: {
    category: 'Dashboard',
    permissions: [
      { name: 'dashboard.view', display_name: 'Ver Dashboard', description: 'Visualizar dashboard principal' },
      { name: 'dashboard.view_analytics', display_name: 'Ver Analytics', description: 'Visualizar analytics avançados' },
    ]
  },

  // ==============================================================================
  // GESTÃO DE USUÁRIOS
  // ==============================================================================
  usuarios: {
    category: 'Gestão',
    permissions: [
      { name: 'usuarios.view', display_name: 'Ver Usuários', description: 'Listar e visualizar usuários' },
      { name: 'usuarios.create', display_name: 'Criar Usuários', description: 'Criar novos usuários' },
      { name: 'usuarios.edit', display_name: 'Editar Usuários', description: 'Editar dados de usuários' },
      { name: 'usuarios.delete', display_name: 'Deletar Usuários', description: 'Deletar usuários do sistema' },
      { name: 'usuarios.manage', display_name: 'Gerenciar Usuários', description: 'Acesso completo a usuários' },
      { name: 'usuarios.manage_permissions', display_name: 'Gerenciar Permissões', description: 'Atribuir roles e permissões' },
    ]
  },

  // ==============================================================================
  // ORGANIZAÇÕES
  // ==============================================================================
  organizacoes: {
    category: 'Gestão',
    permissions: [
      { name: 'organizacoes.view', display_name: 'Ver Organizações', description: 'Listar e visualizar organizações' },
      { name: 'organizacoes.create', display_name: 'Criar Organizações', description: 'Criar novas organizações' },
      { name: 'organizacoes.edit', display_name: 'Editar Organizações', description: 'Editar dados de organizações' },
      { name: 'organizacoes.delete', display_name: 'Deletar Organizações', description: 'Deletar organizações' },
      { name: 'organizacoes.manage', display_name: 'Gerenciar Organizações', description: 'Acesso completo a organizações' },
    ]
  },

  // ==============================================================================
  // PLANTAS
  // ==============================================================================
  plantas: {
    category: 'Gestão de Energia',
    permissions: [
      { name: 'plantas.view', display_name: 'Ver Plantas', description: 'Listar e visualizar plantas' },
      { name: 'plantas.create', display_name: 'Criar Plantas', description: 'Criar novas plantas' },
      { name: 'plantas.edit', display_name: 'Editar Plantas', description: 'Editar dados de plantas' },
      { name: 'plantas.delete', display_name: 'Deletar Plantas', description: 'Deletar plantas' },
      { name: 'plantas.manage', display_name: 'Gerenciar Plantas', description: 'Acesso completo a plantas' },
      { name: 'plantas.view_own', display_name: 'Ver Minhas Plantas', description: 'Ver apenas suas próprias plantas' },
    ]
  },

  // ==============================================================================
  // UNIDADES CONSUMIDORAS
  // ==============================================================================
  unidades: {
    category: 'Gestão de Energia',
    permissions: [
      { name: 'unidades.view', display_name: 'Ver Unidades', description: 'Listar e visualizar unidades consumidoras' },
      { name: 'unidades.create', display_name: 'Criar Unidades', description: 'Criar novas unidades' },
      { name: 'unidades.edit', display_name: 'Editar Unidades', description: 'Editar dados de unidades' },
      { name: 'unidades.delete', display_name: 'Deletar Unidades', description: 'Deletar unidades' },
      { name: 'unidades.manage', display_name: 'Gerenciar Unidades', description: 'Acesso completo a unidades' },
    ]
  },

  // ==============================================================================
  // EQUIPAMENTOS
  // ==============================================================================
  equipamentos: {
    category: 'Gestão de Energia',
    permissions: [
      { name: 'equipamentos.view', display_name: 'Ver Equipamentos', description: 'Listar e visualizar equipamentos' },
      { name: 'equipamentos.create', display_name: 'Criar Equipamentos', description: 'Criar novos equipamentos' },
      { name: 'equipamentos.edit', display_name: 'Editar Equipamentos', description: 'Editar dados de equipamentos' },
      { name: 'equipamentos.delete', display_name: 'Deletar Equipamentos', description: 'Deletar equipamentos' },
      { name: 'equipamentos.manage', display_name: 'Gerenciar Equipamentos', description: 'Acesso completo a equipamentos' },
    ]
  },

  // ==============================================================================
  // MONITORAMENTO
  // ==============================================================================
  monitoramento: {
    category: 'Monitoramento',
    permissions: [
      { name: 'monitoramento.view', display_name: 'Ver Monitoramento', description: 'Visualizar dados de monitoramento' },
      { name: 'monitoramento.view_consumo', display_name: 'Ver Consumo', description: 'Visualizar dados de consumo de energia' },
      { name: 'monitoramento.view_geracao', display_name: 'Ver Geração', description: 'Visualizar dados de geração de energia' },
      { name: 'monitoramento.view_analytics', display_name: 'Ver Analytics', description: 'Visualizar analytics avançados' },
      { name: 'monitoramento.export', display_name: 'Exportar Dados', description: 'Exportar dados de monitoramento' },
    ]
  },

  // ==============================================================================
  // SCADA & SUPERVISÓRIO
  // ==============================================================================
  scada: {
    category: 'Supervisório',
    permissions: [
      { name: 'scada.view', display_name: 'Ver SCADA', description: 'Visualizar sistema SCADA' },
      { name: 'scada.control', display_name: 'Controlar SCADA', description: 'Controlar equipamentos via SCADA' },
      { name: 'scada.view_logs', display_name: 'Ver Logs', description: 'Visualizar logs de eventos' },
      { name: 'scada.view_alarms', display_name: 'Ver Alarmes', description: 'Visualizar alarmes do sistema' },
      { name: 'scada.acknowledge_alarms', display_name: 'Reconhecer Alarmes', description: 'Reconhecer e tratar alarmes' },
    ]
  },

  supervisorio: {
    category: 'Supervisório',
    permissions: [
      { name: 'supervisorio.view', display_name: 'Ver Supervisório', description: 'Visualizar sistema supervisório' },
      { name: 'supervisorio.view_sinoptico', display_name: 'Ver Sinóptico', description: 'Visualizar sinóptico dos ativos' },
      { name: 'supervisorio.view_logs', display_name: 'Ver Logs de Eventos', description: 'Visualizar histórico de eventos' },
      { name: 'supervisorio.manage', display_name: 'Gerenciar Supervisório', description: 'Configurar sistema supervisório' },
    ]
  },

  // ==============================================================================
  // COMERCIAL - PROSPECÇÃO
  // ==============================================================================
  prospeccao: {
    category: 'Comercial',
    permissions: [
      { name: 'prospeccao.view', display_name: 'Ver Prospecções', description: 'Listar e visualizar prospecções' },
      { name: 'prospeccao.create', display_name: 'Criar Prospecções', description: 'Criar novas prospecções' },
      { name: 'prospeccao.edit', display_name: 'Editar Prospecções', description: 'Editar dados de prospecções' },
      { name: 'prospeccao.delete', display_name: 'Deletar Prospecções', description: 'Deletar prospecções' },
      { name: 'prospeccao.manage', display_name: 'Gerenciar Prospecções', description: 'Acesso completo a prospecções' },
      { name: 'prospeccao.view_own', display_name: 'Ver Minhas Prospecções', description: 'Ver apenas suas próprias prospecções' },
    ]
  },

  // ==============================================================================
  // COMERCIAL - OPORTUNIDADES
  // ==============================================================================
  oportunidades: {
    category: 'Comercial',
    permissions: [
      { name: 'oportunidades.view', display_name: 'Ver Oportunidades', description: 'Listar e visualizar oportunidades' },
      { name: 'oportunidades.create', display_name: 'Criar Oportunidades', description: 'Criar novas oportunidades' },
      { name: 'oportunidades.edit', display_name: 'Editar Oportunidades', description: 'Editar dados de oportunidades' },
      { name: 'oportunidades.delete', display_name: 'Deletar Oportunidades', description: 'Deletar oportunidades' },
      { name: 'oportunidades.manage', display_name: 'Gerenciar Oportunidades', description: 'Acesso completo a oportunidades' },
    ]
  },

  // ==============================================================================
  // FINANCEIRO
  // ==============================================================================
  financeiro: {
    category: 'Financeiro',
    permissions: [
      { name: 'financeiro.view', display_name: 'Ver Financeiro', description: 'Visualizar dados financeiros básicos' },
      { name: 'financeiro.view_reports', display_name: 'Ver Relatórios', description: 'Visualizar relatórios financeiros' },
      { name: 'financeiro.view_admin', display_name: 'Ver Admin Financeiro', description: 'Acesso administrativo ao financeiro' },
      { name: 'financeiro.manage', display_name: 'Gerenciar Financeiro', description: 'Gerenciar módulo financeiro' },
      { name: 'financeiro.export', display_name: 'Exportar Dados', description: 'Exportar dados financeiros' },
    ]
  },

  // ==============================================================================
  // CLUBE AUPUS
  // ==============================================================================
  clube: {
    category: 'Clube',
    permissions: [
      { name: 'clube.view', display_name: 'Ver Clube', description: 'Acessar área do clube' },
      { name: 'clube.view_associado', display_name: 'Área do Associado', description: 'Acessar área do associado' },
      { name: 'clube.view_proprietario', display_name: 'Área do Proprietário', description: 'Acessar área do proprietário' },
      { name: 'clube.manage', display_name: 'Gerenciar Clube', description: 'Gerenciar clube Aupus' },
    ]
  },

  // ==============================================================================
  // CONCESSIONÁRIAS
  // ==============================================================================
  concessionarias: {
    category: 'Sistema',
    permissions: [
      { name: 'concessionarias.view', display_name: 'Ver Concessionárias', description: 'Listar e visualizar concessionárias' },
      { name: 'concessionarias.create', display_name: 'Criar Concessionárias', description: 'Criar novas concessionárias' },
      { name: 'concessionarias.edit', display_name: 'Editar Concessionárias', description: 'Editar dados de concessionárias' },
      { name: 'concessionarias.delete', display_name: 'Deletar Concessionárias', description: 'Deletar concessionárias' },
      { name: 'concessionarias.manage', display_name: 'Gerenciar Concessionárias', description: 'Acesso completo a concessionárias' },
    ]
  },

  // ==============================================================================
  // CONFIGURAÇÕES
  // ==============================================================================
  configuracoes: {
    category: 'Sistema',
    permissions: [
      { name: 'configuracoes.view', display_name: 'Ver Configurações', description: 'Visualizar configurações do sistema' },
      { name: 'configuracoes.edit', display_name: 'Editar Configurações', description: 'Editar configurações do sistema' },
      { name: 'configuracoes.manage', display_name: 'Gerenciar Configurações', description: 'Acesso completo a configurações' },
    ]
  },

  // ==============================================================================
  // DOCUMENTOS
  // ==============================================================================
  documentos: {
    category: 'Sistema',
    permissions: [
      { name: 'documentos.view', display_name: 'Ver Documentos', description: 'Visualizar documentos' },
      { name: 'documentos.upload', display_name: 'Upload Documentos', description: 'Fazer upload de documentos' },
      { name: 'documentos.download', display_name: 'Download Documentos', description: 'Baixar documentos' },
      { name: 'documentos.delete', display_name: 'Deletar Documentos', description: 'Deletar documentos' },
      { name: 'documentos.manage', display_name: 'Gerenciar Documentos', description: 'Acesso completo a documentos' },
    ]
  },

  // ==============================================================================
  // RELATÓRIOS
  // ==============================================================================
  relatorios: {
    category: 'Sistema',
    permissions: [
      { name: 'relatorios.view', display_name: 'Ver Relatórios', description: 'Visualizar relatórios' },
      { name: 'relatorios.export', display_name: 'Exportar Relatórios', description: 'Exportar relatórios' },
      { name: 'relatorios.create', display_name: 'Criar Relatórios', description: 'Criar relatórios personalizados' },
    ]
  },

  // ==============================================================================
  // SUPER ADMIN
  // ==============================================================================
  admin: {
    category: 'Administração',
    permissions: [
      { name: 'admin.super', display_name: 'Super Admin', description: 'Acesso total ao sistema' },
      { name: 'admin.impersonate', display_name: 'Personificar Usuário', description: 'Fazer login como outro usuário' },
      { name: 'admin.view_logs', display_name: 'Ver Logs do Sistema', description: 'Visualizar logs do sistema' },
      { name: 'admin.manage_permissions', display_name: 'Gerenciar Permissões', description: 'Gerenciar roles e permissões' },
    ]
  },
};

/**
 * Gera array plano de todas as permissões
 */
export function getAllPermissions() {
  const permissions: Array<{
    name: string;
    display_name: string;
    description: string;
    category: string;
  }> = [];

  Object.entries(PERMISSIONS_STRUCTURE).forEach(([key, config]) => {
    config.permissions.forEach(permission => {
      permissions.push({
        ...permission,
        category: config.category
      });
    });
  });

  return permissions;
}

/**
 * Gera permissões agrupadas por categoria
 */
export function getPermissionsByCategory() {
  const grouped: Record<string, Array<{
    name: string;
    display_name: string;
    description: string;
  }>> = {};

  Object.entries(PERMISSIONS_STRUCTURE).forEach(([key, config]) => {
    if (!grouped[config.category]) {
      grouped[config.category] = [];
    }
    grouped[config.category].push(...config.permissions);
  });

  return grouped;
}

/**
 * Total de permissões definidas
 */
export function getTotalPermissions() {
  return getAllPermissions().length;
}
