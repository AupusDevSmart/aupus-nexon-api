import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { novoId26 } from '../../core/common/cliente-info';
import { colunaTrilhaAusente } from '../logs-mqtt/logs-mqtt-filtros';
import { PivoConfigDto, ProgramacaoPivoDto } from './dto/pivos.dto';
import { agruparConjugados, janelaOuPadrao, LinhaConjugado, PONTA_PADRAO, RESERVADO_PADRAO } from './pivo-config.util';

interface ProgramacaoRow {
  id: string;
  nome: string;
  ativo: boolean;
  hora_inicio: string;
  dias: number[];
  modo: string;
  angulo_inicial: unknown;
  angulo_final: unknown;
  duracao_min: number | null;
  sentido: string;
  velocidade: unknown;
  com_agua: boolean;
  created_at: Date;
  updated_at: Date;
}

const PROG_COLS = Prisma.sql`TRIM(id) AS id, nome, ativo, hora_inicio, dias, modo, angulo_inicial, angulo_final,
  duracao_min, sentido, velocidade, com_agua, created_at, updated_at`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Pivô (apps NexON v2): configuração (bloqueio de ponta, horário reservado,
 * motobomba do sistema conjugado) e programações.
 *
 * PROGRAMAÇÕES SÃO SÓ ARMAZENADAS: o servidor não tem agendador de comando e não
 * liga pivô sozinho. Quem executa é o operador (app/web) ou o CLP. O bloqueio de
 * ponta, esse sim, vale no acionar (EquipamentosCmdService → COMANDO_BLOQUEADO_PONTA).
 *
 * Tabelas pivo_config / pivo_programacoes (db/manual-migrations/2026-09-28_5-pivos.sql)
 * ficam fora do schema Prisma. Sem o SQL aplicado: leituras devolvem padrão/vazio
 * e escritas 404 (o app mostra "Programação disponível após atualização do servidor").
 */
@Injectable()
export class PivosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  // ==========================================================================
  // Configuração
  // ==========================================================================

  async getConfig(equipamentoId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    let row: { bloqueio_ponta: unknown; reservado: unknown; motobomba_equipamento_id: string | null; updated_at: Date } | undefined;
    try {
      const rows = await this.prisma.$queryRaw<Array<typeof row & object>>`
        SELECT bloqueio_ponta, reservado, TRIM(motobomba_equipamento_id) AS motobomba_equipamento_id, updated_at
        FROM pivo_config WHERE equipamento_id = ${eq.id}::bpchar LIMIT 1`;
      row = rows[0];
    } catch (e) {
      if (!colunaTrilhaAusente(e)) throw e;
    }
    return {
      equipamento_id: eq.id,
      bloqueio_ponta: janelaOuPadrao(row?.bloqueio_ponta, PONTA_PADRAO),
      reservado: janelaOuPadrao(row?.reservado, RESERVADO_PADRAO),
      origem_ponta: eq.numero_uc || eq.concessionaria ? { numero_uc: eq.numero_uc, concessionaria: eq.concessionaria } : null,
      motobomba_equipamento_id: row?.motobomba_equipamento_id ?? null,
      updated_at: row?.updated_at ?? null,
    };
  }

  async putConfig(equipamentoId: string, dto: PivoConfigDto, user?: ScopedUser & { permissions?: string[] }) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const atual = await this.getConfig(eq.id, user);

    let motobomba = atual.motobomba_equipamento_id;
    if (dto.motobomba_equipamento_id !== undefined) {
      motobomba = dto.motobomba_equipamento_id?.trim() || null;
      if (motobomba) {
        if (motobomba === eq.id) throw new BadRequestException('O pivô não pode ser a própria motobomba');
        const mb = await this.carregarEquipamento(motobomba, user);
        if (mb.unidade_id !== eq.unidade_id) {
          throw new BadRequestException('A motobomba tem de ser da mesma instalação do pivô');
        }
      }
    }
    const bloqueio = dto.bloqueio_ponta ? janelaOuPadrao(dto.bloqueio_ponta, PONTA_PADRAO) : atual.bloqueio_ponta;
    const reservado = dto.reservado ? janelaOuPadrao(dto.reservado, RESERVADO_PADRAO) : atual.reservado;

    await this.escrever(() => this.prisma.$executeRaw`
      INSERT INTO pivo_config (equipamento_id, bloqueio_ponta, reservado, motobomba_equipamento_id, updated_at, updated_by)
      VALUES (${eq.id}, ${JSON.stringify(bloqueio)}::jsonb, ${JSON.stringify(reservado)}::jsonb, ${motobomba}, now(), ${user?.id?.trim() ?? null})
      ON CONFLICT (equipamento_id) DO UPDATE SET
        bloqueio_ponta = EXCLUDED.bloqueio_ponta,
        reservado = EXCLUDED.reservado,
        motobomba_equipamento_id = EXCLUDED.motobomba_equipamento_id,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by`);
    return this.getConfig(eq.id, user);
  }

  // ==========================================================================
  // Programações (só armazenadas — ver doc da classe)
  // ==========================================================================

  async listarProgramacoes(equipamentoId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    try {
      const rows = await this.prisma.$queryRaw<ProgramacaoRow[]>`
        SELECT ${PROG_COLS}
        FROM pivo_programacoes
        WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL
        ORDER BY hora_inicio, nome`;
      return rows.map((r) => this.formatarProgramacao(r));
    } catch (e) {
      if (colunaTrilhaAusente(e)) return [];
      throw e;
    }
  }

  async criarProgramacao(equipamentoId: string, dto: ProgramacaoPivoDto, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const p = this.normalizarProgramacao(dto);
    const id = novoId26();
    const uid = user?.id?.trim() ?? null;
    await this.escrever(() => this.prisma.$executeRaw`
      INSERT INTO pivo_programacoes
        (id, equipamento_id, nome, ativo, hora_inicio, dias, modo, angulo_inicial, angulo_final, duracao_min,
         sentido, velocidade, com_agua, created_by, updated_by, created_at, updated_at)
      VALUES
        (${id}, ${eq.id}, ${p.nome}, ${p.ativo}, ${p.hora_inicio}, ${p.dias}::smallint[], ${p.modo},
         ${p.angulo_inicial}, ${p.angulo_final}, ${p.duracao_min}, ${p.sentido}, ${p.velocidade}, ${p.com_agua},
         ${uid}, ${uid}, now(), now())`);
    return this.buscarProgramacao(eq.id, id);
  }

  async atualizarProgramacao(equipamentoId: string, progId: string, dto: ProgramacaoPivoDto, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const p = this.normalizarProgramacao(dto);
    const n = await this.escrever(() => this.prisma.$executeRaw`
      UPDATE pivo_programacoes SET
        nome = ${p.nome}, ativo = ${p.ativo}, hora_inicio = ${p.hora_inicio}, dias = ${p.dias}::smallint[],
        modo = ${p.modo}, angulo_inicial = ${p.angulo_inicial}, angulo_final = ${p.angulo_final},
        duracao_min = ${p.duracao_min}, sentido = ${p.sentido}, velocidade = ${p.velocidade},
        com_agua = ${p.com_agua}, updated_by = ${user?.id?.trim() ?? null}, updated_at = now()
      WHERE TRIM(id) = ${progId.trim()} AND equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL`);
    if (!n) throw new NotFoundException('Programação não encontrada');
    return this.buscarProgramacao(eq.id, progId.trim());
  }

  async removerProgramacao(equipamentoId: string, progId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const n = await this.escrever(() => this.prisma.$executeRaw`
      UPDATE pivo_programacoes SET deleted_at = now(), updated_by = ${user?.id?.trim() ?? null}, updated_at = now()
      WHERE TRIM(id) = ${progId.trim()} AND equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL`);
    if (!n) throw new NotFoundException('Programação não encontrada');
    return { ok: true, id: progId.trim() };
  }

  // ==========================================================================
  // Sistema conjugado
  // ==========================================================================

  async conjugados(unidadeId: string, user?: ScopedUser) {
    const uid = unidadeId.trim();
    const unidade = await this.prisma.unidades.findFirst({ where: { id: uid, deleted_at: null }, select: { id: true } });
    if (!unidade) throw new NotFoundException('Instalação não encontrada');
    if (user) await this.scope.assertEntityInScope('unidade', uid, user);
    try {
      const linhas = await this.prisma.$queryRaw<LinhaConjugado[]>`
        SELECT TRIM(p.id) AS pivo_id, p.nome AS pivo_nome, TRIM(mb.id) AS motobomba_id, mb.nome AS motobomba_nome
        FROM pivo_config c
        JOIN equipamentos p ON p.id = c.equipamento_id AND p.deleted_at IS NULL
        JOIN equipamentos mb ON mb.id = c.motobomba_equipamento_id AND mb.deleted_at IS NULL
        LEFT JOIN equipamentos pai ON pai.id = p.equipamento_pai_id
        WHERE COALESCE(p.unidade_id, pai.unidade_id) = ${uid}::bpchar`;
      return agruparConjugados(linhas);
    } catch (e) {
      if (colunaTrilhaAusente(e)) return [];
      throw e;
    }
  }

  // ==========================================================================
  // Internos
  // ==========================================================================

  private async carregarEquipamento(id: string, user?: ScopedUser) {
    const eqId = (id ?? '').trim();
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; nome: string; unidade_id: string | null; numero_uc: string | null; concessionaria: string | null;
    }>>`
      SELECT TRIM(e.id) AS id, e.nome, TRIM(un.id) AS unidade_id, un.numero_uc, ce.nome AS concessionaria
      FROM equipamentos e
      LEFT JOIN equipamentos pai ON pai.id = e.equipamento_pai_id
      LEFT JOIN unidades un ON un.id = COALESCE(e.unidade_id, pai.unidade_id)
      LEFT JOIN concessionarias_energia ce ON ce.id = un.concessionaria_id
      WHERE e.id = ${eqId}::bpchar AND e.deleted_at IS NULL
      LIMIT 1`;
    const eq = rows[0];
    if (!eq) throw new NotFoundException('Equipamento não encontrado');
    if (user) await this.scope.assertEntityInScope('equipamento', eq.id, user);
    return eq;
  }

  /**
   * Operador com permissão por instalação (usuario_unidade_permissoes) só mexe na
   * programação/config se puder COMANDAR ali — mesma regra do acionar.
   */
  private async exigirComandoNaUnidade(unidadeId: string | null, user?: ScopedUser) {
    const userId = user?.id?.trim();
    if (!userId) return;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ linhas: number; comandar: boolean | null }>>`
        SELECT (SELECT COUNT(*) FROM usuario_unidade_permissoes WHERE usuario_id = ${userId}::bpchar)::int AS linhas,
               (SELECT comandar FROM usuario_unidade_permissoes
                 WHERE usuario_id = ${userId}::bpchar AND unidade_id = ${unidadeId ?? ''}::bpchar LIMIT 1) AS comandar`;
      const r = rows[0];
      if (r && Number(r.linhas) > 0 && r.comandar !== true) {
        throw new ForbiddenException({ message: 'Sem permissão para comandar nesta instalação', code: 'SEM_PERMISSAO_UNIDADE' });
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      if (!colunaTrilhaAusente(e)) throw e;
    }
  }

  /** Escrita em tabela v2: tabela ausente → 404 "indisponível" (o app degrada). */
  private async escrever<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (colunaTrilhaAusente(e)) {
        throw new NotFoundException('Configuração de pivô indisponível neste servidor (SQL 2026-09-28_5 não aplicado)');
      }
      throw e;
    }
  }

  private normalizarProgramacao(dto: ProgramacaoPivoDto) {
    if (dto.modo === 'tempo' && !dto.duracao_min) throw new BadRequestException('duracao_min é obrigatório no modo tempo');
    return {
      nome: dto.nome.trim(),
      ativo: dto.ativo ?? true,
      hora_inicio: dto.hora_inicio,
      dias: [...new Set(dto.dias.map(Number))].sort((a, b) => a - b),
      modo: dto.modo,
      angulo_inicial: dto.angulo_inicial ?? null,
      angulo_final: dto.angulo_final ?? null,
      duracao_min: dto.duracao_min ?? null,
      sentido: dto.sentido,
      velocidade: dto.velocidade ?? null,
      com_agua: dto.com_agua ?? true,
    };
  }

  private async buscarProgramacao(equipamentoId: string, id: string) {
    const rows = await this.prisma.$queryRaw<ProgramacaoRow[]>`
      SELECT ${PROG_COLS} FROM pivo_programacoes
      WHERE TRIM(id) = ${id} AND equipamento_id = ${equipamentoId}::bpchar LIMIT 1`;
    if (!rows[0]) throw new NotFoundException('Programação não encontrada');
    return this.formatarProgramacao(rows[0]);
  }

  private formatarProgramacao(r: ProgramacaoRow) {
    return {
      id: r.id,
      nome: r.nome,
      ativo: r.ativo,
      hora_inicio: r.hora_inicio,
      dias: (r.dias ?? []).map(Number),
      modo: r.modo,
      angulo_inicial: num(r.angulo_inicial),
      angulo_final: num(r.angulo_final),
      duracao_min: r.duracao_min === null ? null : Number(r.duracao_min),
      sentido: r.sentido,
      velocidade: num(r.velocidade),
      com_agua: r.com_agua,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}
