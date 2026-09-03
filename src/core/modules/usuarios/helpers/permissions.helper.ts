// src/modules/usuarios/helpers/permissions.helper.ts

export interface UserPermission {
  id: number;
  name: string;
  guard_name: string;
  source: 'role' | 'direct';
}

export interface UserRole {
  id: number;
  name: string;
  guard_name: string;
}

export interface UserPermissionsData {
  role: UserRole | null;
  permissions: UserPermission[];
  permissionNames: string[];
}

/**
 * Helper para trabalhar com permissões de usuário
 */
export class PermissionsHelper {
  
  /**
   * Verifica se o usuário tem uma permissão específica
   */
  static hasPermission(userPermissions: UserPermissionsData, permissionName: string): boolean {
    return userPermissions.permissionNames.includes(permissionName);
  }

  /**
   * Verifica se o usuário tem pelo menos uma das permissões
   */
  static hasAnyPermission(userPermissions: UserPermissionsData, permissionNames: string[]): boolean {
    return permissionNames.some(permission => 
      userPermissions.permissionNames.includes(permission)
    );
  }

  /**
   * Verifica se o usuário tem todas as permissões
   */
  static hasAllPermissions(userPermissions: UserPermissionsData, permissionNames: string[]): boolean {
    return permissionNames.every(permission => 
      userPermissions.permissionNames.includes(permission)
    );
  }

  /**
   * Filtra permissões por fonte (role ou direct)
   */
  static getPermissionsBySource(userPermissions: UserPermissionsData, source: 'role' | 'direct'): UserPermission[] {
    return userPermissions.permissions.filter(p => p.source === source);
  }

  /**
   * Obtém apenas os nomes das permissões
   */
  static getPermissionNames(permissions: UserPermission[]): string[] {
    return permissions.map(p => p.name);
  }

  /**
   * Combina permissões de role e diretas, removendo duplicatas
   */
  static combinePermissions(
    rolePermissions: UserPermission[], 
    directPermissions: UserPermission[]
  ): UserPermission[] {
    const combined = [...directPermissions];
    const directPermissionIds = directPermissions.map(p => p.id);
    
    // Adiciona permissões do role que não estão nas diretas
    rolePermissions.forEach(rolePermission => {
      if (!directPermissionIds.includes(rolePermission.id)) {
        combined.push(rolePermission);
      }
    });

    return combined.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Categoriza permissões por grupos funcionais
   */
  static categorizePermissions(permissions: UserPermission[]): Record<string, UserPermission[]> {
    const categories = {
      'Dashboard': ['Dashboard'],
      'Monitoramento': ['MonitoramentoConsumo', 'MonitoramentoClientes'],
      'Gestão de Energia': ['GeracaoEnergia', 'MinhasUsinas', 'Equipamentos', 'Plantas'],
      'Comercial': ['GestaoOportunidades', 'Oportunidades', 'Prospeccao', 'ProspeccaoListagem'],
      'Financeiro': ['Financeiro'],
      'Clube': ['ClubeAupus', 'AreaDoProprietario', 'AreaDoAssociado'],
      'Gestão': ['Usuarios', 'Organizacoes', 'Associados', 'Proprietarios'],
      'Unidades': ['UnidadesConsumidoras'],
      'Sistema': ['Configuracoes', 'Documentos']
    };

    const categorized: Record<string, UserPermission[]> = {};
    
    // Inicializar categorias
    Object.keys(categories).forEach(category => {
      categorized[category] = [];
    });

    // Categorizar permissões
    permissions.forEach(permission => {
      let found = false;
      for (const [category, permissionNames] of Object.entries(categories)) {
        if (permissionNames.includes(permission.name)) {
          categorized[category].push(permission);
          found = true;
          break;
        }
      }
      
      // Se não encontrou categoria, adiciona em "Outros"
      if (!found) {
        if (!categorized['Outros']) {
          categorized['Outros'] = [];
        }
        categorized['Outros'].push(permission);
      }
    });

    // Remover categorias vazias
    Object.keys(categorized).forEach(category => {
      if (categorized[category].length === 0) {
        delete categorized[category];
      }
    });

    return categorized;
  }

  /**
   * Cria um resumo das permissões do usuário
   */
  static createPermissionsSummary(userPermissions: UserPermissionsData): {
    role: string | null;
    totalPermissions: number;
    rolePermissions: number;
    directPermissions: number;
    categories: string[];
  } {
    const rolePerms = this.getPermissionsBySource(userPermissions, 'role');
    const directPerms = this.getPermissionsBySource(userPermissions, 'direct');
    const categories = Object.keys(this.categorizePermissions(userPermissions.permissions));

    return {
      role: userPermissions.role?.name || null,
      totalPermissions: userPermissions.permissions.length,
      rolePermissions: rolePerms.length,
      directPermissions: directPerms.length,
      categories
    };
  }
}