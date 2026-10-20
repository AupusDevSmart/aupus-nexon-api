import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { papelCanonico } from '../auth/papeis';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Busca na trilha de acesso (auditoria_acessos): quem fez o quê, em quem, onde.
 * Só leitura — a tabela não aceita UPDATE/DELETE (PER-44).
 *
 * Filtros: acao (vírgula), autor / alvo (id ou parte do nome), objetoTipo,
 * objetoId, resultado (ok|negado|erro), plantaId, de / ate (AAAA-MM-DD), q (texto).
 * Admin e analistas veem tudo; proprietário vê o que tocou as plantas dele ou
 * foi feito por ele; operador não vê.
 */
@ApiTags('Auditoria')
@ApiBearerAuth()
@Controller('auditoria')
export class AuditoriaAcessosController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  @Get('acessos')
  @ApiOperation({ summary: 'Busca na trilha de acesso (cadastros, papéis, vínculos, exportações, 403)' })
  async buscar(@Query() q: Record<string, string | undefined>, @CurrentUser() user: any) {
    const papel = papelCanonico(user?.role);
    if (papel === 'operador' || papel === 'outro') throw new ForbiddenException('Recurso fora do escopo do usuario');

    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    const acoes = (q.acao ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (acoes.length) conds.push(Prisma.sql`a.acao = ANY(${acoes}::text[])`);
    if (q.resultado) conds.push(Prisma.sql`a.resultado = ${q.resultado}`);
    if (q.objetoTipo) conds.push(Prisma.sql`a.objeto_tipo = ${q.objetoTipo}`);
    if (q.objetoId) conds.push(Prisma.sql`a.objeto_id = ${q.objetoId.trim()}`);
    if (q.plantaId) conds.push(Prisma.sql`${q.plantaId.trim()} = ANY(a.planta_ids)`);
    if (q.de) conds.push(Prisma.sql`a.created_at >= ${q.de}::date`);
    if (q.ate) conds.push(Prisma.sql`a.created_at < (${q.ate}::date + 1)`);
    const pessoa = (col: 'autor' | 'alvo', v?: string) => {
      if (!v?.trim()) return;
      const t = v.trim();
      conds.push(col === 'autor'
        ? Prisma.sql`(TRIM(a.autor_id) = ${t} OR COALESCE(a.autor_nome, au.nome) ILIKE ${'%' + t + '%'})`
        : Prisma.sql`(TRIM(a.alvo_usuario_id) = ${t} OR COALESCE(a.alvo_nome, al.nome) ILIKE ${'%' + t + '%'})`);
    };
    pessoa('autor', q.autor);
    pessoa('alvo', q.alvo);
    if (q.q?.trim()) conds.push(Prisma.sql`(a.mensagem ILIKE ${'%' + q.q.trim() + '%'} OR a.detalhes::text ILIKE ${'%' + q.q.trim() + '%'})`);

    if (papel === 'proprietario') {
      const plantas = (await this.scope.getScope(user)) ?? [];
      conds.push(Prisma.sql`(TRIM(a.autor_id) = ${String(user.id).trim()} OR a.planta_ids && ${plantas}::text[])`);
    }

    const limite = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const pagina = Math.max(Number(q.page) || 1, 1);
    const where = Prisma.join(conds, ' AND ');
    const [linhas, total] = await Promise.all([
      this.prisma.$queryRaw<any[]>`
        SELECT TRIM(a.id) AS id, a.created_at, a.acao, a.resultado, a.mensagem, a.detalhes,
               TRIM(a.autor_id) AS autor_id, COALESCE(au.nome, a.autor_nome) AS autor_nome,
               TRIM(a.alvo_usuario_id) AS alvo_id, COALESCE(al.nome, a.alvo_nome) AS alvo_nome,
               a.objeto_tipo, a.objeto_id, a.planta_ids, a.unidade_ids, a.dispositivo, a.rota
        FROM auditoria_acessos a
        LEFT JOIN usuarios au ON au.id = a.autor_id
        LEFT JOIN usuarios al ON al.id = a.alvo_usuario_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM auditoria_acessos a
        LEFT JOIN usuarios au ON au.id = a.autor_id
        LEFT JOIN usuarios al ON al.id = a.alvo_usuario_id
        WHERE ${where}`,
    ]);
    return { data: linhas, total: Number(total[0]?.n ?? 0), page: pagina, limit: limite };
  }
}
