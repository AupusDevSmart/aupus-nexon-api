import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type Requester = { id?: string; role?: string | null };

@Injectable()
export class PlantaOperadoresService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista plantas onde o usuario figura como operador (mirror para o UsuarioModal).
   * Nao requer scope check — qualquer usuario pode consultar seu proprio vinculo;
   * decisao de autorizacao fica no controller (admin-like ou self).
   */
  async listByOperador(usuarioId: string) {
    const uid = usuarioId.trim();
    const vinculos = await this.prisma.planta_operadores.findMany({
      where: { usuario_id: uid },
      orderBy: { created_at: 'desc' },
      include: {
        planta: {
          select: {
            id: true,
            nome: true,
            cnpj: true,
            cidade: true,
            uf: true,
            deleted_at: true,
          },
        },
      },
    });
    return vinculos
      .filter((v) => !v.planta.deleted_at)
      .map((v) => ({
        id: v.id.toString(),
        planta_id: v.planta_id,
        usuario_id: v.usuario_id,
        created_at: v.created_at,
        planta: {
          id: v.planta.id?.trim() ?? v.planta.id,
          nome: v.planta.nome,
          cnpj: v.planta.cnpj,
          cidade: v.planta.cidade,
          uf: v.planta.uf,
        },
      }));
  }

  /**
   * Lista operadores vinculados a uma planta.
   */
  async list(plantaId: string, requester?: Requester) {
    const planta = await this.garantirAcessoPlanta(plantaId, requester);

    const vinculos = await this.prisma.planta_operadores.findMany({
      where: { planta_id: planta.id },
      orderBy: { created_at: 'desc' },
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            email: true,
            telefone: true,
            is_active: true,
            status: true,
          },
        },
      },
    });

    return vinculos.map((v) => ({
      id: v.id.toString(),
      planta_id: v.planta_id,
      usuario_id: v.usuario_id,
      created_at: v.created_at,
      usuario: v.usuario,
    }));
  }

  /**
   * Vincula um operador a uma planta.
   */
  async add(plantaId: string, usuarioId: string, requester?: Requester) {
    const planta = await this.garantirAcessoPlanta(plantaId, requester);

    const usuario = await this.prisma.usuarios.findFirst({
      where: { id: usuarioId, deleted_at: null },
    });
    if (!usuario) throw new NotFoundException('Usuario nao encontrado');

    // Validar que o usuario tem role 'operador' via spatie
    const roleVinc = await this.prisma.model_has_roles.findFirst({
      where: { model_id: usuarioId, model_type: 'App\\Models\\User' },
      include: { roles: true },
    });
    const roleName = roleVinc?.roles?.name ?? usuario.role;
    if (roleName !== 'operador') {
      throw new BadRequestException(`Apenas usuarios com role "operador" podem ser vinculados (role atual: ${roleName})`);
    }

    try {
      const vinculo = await this.prisma.planta_operadores.create({
        data: {
          planta_id: planta.id,
          usuario_id: usuarioId,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      return { id: vinculo.id.toString(), planta_id: vinculo.planta_id, usuario_id: vinculo.usuario_id };
    } catch (err: any) {
      if (err.code === 'P2002') {
        throw new ConflictException('Operador ja esta vinculado a esta planta');
      }
      throw err;
    }
  }

  /**
   * Desvincula um operador de uma planta.
   */
  async remove(plantaId: string, usuarioId: string, requester?: Requester) {
    const planta = await this.garantirAcessoPlanta(plantaId, requester);

    const vinculo = await this.prisma.planta_operadores.findFirst({
      where: { planta_id: planta.id, usuario_id: usuarioId },
    });
    if (!vinculo) throw new NotFoundException('Vinculo nao encontrado');

    await this.prisma.planta_operadores.delete({ where: { id: vinculo.id } });
    return { message: 'Operador desvinculado da planta com sucesso' };
  }

  /**
   * Garante que o requester pode operar sobre a planta:
   * - analista+: qualquer planta
   * - proprietario: apenas se proprietario_id = requester.id
   * - outros roles: forbidden
   */
  private async garantirAcessoPlanta(plantaId: string, requester?: Requester) {
    const plantaIdTrimmed = plantaId.trim();
    const planta = await this.prisma.plantas.findFirst({
      where: { id: plantaIdTrimmed, deleted_at: null },
      select: { id: true, proprietario_id: true, nome: true },
    });
    if (!planta) throw new NotFoundException('Planta nao encontrada');

    const role = requester?.role;
    const isAdminLike = ['analista', 'gerente', 'admin', 'super_admin'].includes(role ?? '');
    if (isAdminLike) return planta;

    if (role === 'proprietario') {
      if (planta.proprietario_id !== requester?.id) {
        throw new ForbiddenException('Voce so pode gerenciar operadores das suas proprias plantas');
      }
      return planta;
    }

    throw new ForbiddenException('Voce nao tem permissao para gerenciar operadores desta planta');
  }
}
