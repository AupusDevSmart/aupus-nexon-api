import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResponseDto } from './dto';

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Retorna todas as permissões MODERNAS (padrão recurso.acao)
   * Filtra automaticamente permissões legadas (sem ponto)
   */
  async findAll(): Promise<PermissionResponseDto[]> {
    const permissions = await this.prisma.permissions.findMany({
      where: {
        name: {
          contains: '.' // Apenas permissões modernas (recurso.acao)
        }
      },
      orderBy: {
        name: 'asc'
      }
    });

    return permissions.map(permission => ({
      id: Number(permission.id),
      name: permission.name,
      display_name: permission.display_name || permission.name,
      description: permission.description || '',
      guard_name: permission.guard_name,
      created_at: permission.created_at,
      updated_at: permission.updated_at
    }));
  }

  async findOne(id: number): Promise<PermissionResponseDto | null> {
    const permission = await this.prisma.permissions.findUnique({
      where: { id: BigInt(id) }
    });

    if (!permission) {
      return null;
    }

    return {
      id: Number(permission.id),
      name: permission.name,
      display_name: permission.display_name || permission.name,
      description: permission.description || '',
      guard_name: permission.guard_name,
      created_at: permission.created_at,
      updated_at: permission.updated_at
    };
  }

  /**
   * Retorna permissões modernas agrupadas por categoria
   * Categorização baseada no recurso (parte antes do ponto)
   */
  async findGrouped(): Promise<{ [category: string]: PermissionResponseDto[] }> {
    const permissions = await this.findAll();

    // Mapeamento de recursos para categorias
    const resourceToCategory: { [resource: string]: string } = {
      // Dashboard
      'dashboard': 'Dashboard',

      // Gestão
      'usuarios': 'Gestão',
      'organizacoes': 'Gestão',
      'equipe': 'Gestão',

      // Gestão de Energia
      'plantas': 'Gestão de Energia',
      'unidades': 'Gestão de Energia',
      'equipamentos': 'Gestão de Energia',
      'ugs': 'Gestão de Energia',

      // Monitoramento
      'monitoramento': 'Monitoramento',

      // Supervisório
      'scada': 'Supervisório',
      'supervisorio': 'Supervisório',
      'controle': 'Supervisório',

      // Comercial
      'prospeccao': 'Comercial',
      'prospec': 'Comercial',
      'oportunidades': 'Comercial',

      // Financeiro
      'financeiro': 'Financeiro',

      // Clube
      'clube': 'Clube',

      // Sistema
      'concessionarias': 'Sistema',
      'configuracoes': 'Sistema',
      'documentos': 'Sistema',
      'relatorios': 'Sistema',

      // Administração
      'admin': 'Administração',
    };

    const grouped: { [category: string]: PermissionResponseDto[] } = {};

    permissions.forEach(permission => {
      // Extrair recurso (parte antes do ponto)
      const [resource] = permission.name.split('.');

      // Determinar categoria
      const category = resourceToCategory[resource] || 'Outros';

      // Adicionar à categoria
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(permission);
    });

    // Ordenar categorias (ordem fixa)
    const categoryOrder = [
      'Dashboard',
      'Gestão',
      'Gestão de Energia',
      'Monitoramento',
      'Supervisório',
      'Comercial',
      'Financeiro',
      'Clube',
      'Sistema',
      'Administração',
      'Outros'
    ];

    const orderedGrouped: { [category: string]: PermissionResponseDto[] } = {};
    categoryOrder.forEach(category => {
      if (grouped[category] && grouped[category].length > 0) {
        orderedGrouped[category] = grouped[category];
      }
    });

    return orderedGrouped;
  }
}