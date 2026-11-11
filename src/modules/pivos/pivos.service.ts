import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { novoId26 } from '../../core/common/cliente-info';
import { colunaTrilhaAusente } from '../logs-mqtt/logs-mqtt-filtros';
import { PivoConfigDto, ProgramacaoPivoDto } from './dto/pivos.dto';
import { brutoDoEncoder } from './pivo-posicao.util';
import { agoraEmSaoPaulo, lerData, validarAgenda, type Ocupado } from './pivo-agenda.util';
import { capacidades, isGlobal, MSG_SOMENTE_LEITURA, papelCanonico } from '../../core/modules/auth/papeis';
import {
  agruparConjugados,
  camposTecnicosAlterados,
  janelaOuPadrao,
  LinhaConjugado,
  PONTA_PADRAO,
  RESERVADO_PADRAO,
} from './pivo-config.util';

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
  canhao: boolean;
  created_at: Date;
  updated_at: Date;
}

const PROG_COLS = Prisma.sql`TRIM(id) AS id, nome, ativo, hora_inicio, dias, modo, angulo_inicial, angulo_final,
  duracao_min, sentido, velocidade, com_agua,
  COALESCE((to_jsonb(pivo_programacoes)->>'canhao')::boolean, false) AS canhao, created_at, updated_at`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Pivô (apps NexON v2): configuração (bloqueio de ponta, horário reservado,
 * motobomba do sistema conjugado) e programações.
 *
 * Quem EXECUTA as programações (e o início agendado, as paradas e a pausa/retomada
 * da ponta) é o PivoAutomacaoService. O bloqueio de ponta também vale no acionar.
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
    // parametros (SQL 2026-10-15_pivo_parametros): coluna à parte, tolerante a ausente.
    let parametros: Record<string, unknown> = {};
    try {
      const pr = await this.prisma.$queryRaw<Array<{ parametros: unknown }>>`
        SELECT parametros FROM pivo_config WHERE equipamento_id = ${eq.id}::bpchar LIMIT 1`;
      if (pr[0]?.parametros && typeof pr[0].parametros === 'object') parametros = pr[0].parametros as Record<string, unknown>;
    } catch (e) {
      if (!colunaTrilhaAusente(e)) throw e;
    }
    return {
      equipamento_id: eq.id,
      bloqueio_ponta: janelaOuPadrao(row?.bloqueio_ponta, PONTA_PADRAO),
      reservado: janelaOuPadrao(row?.reservado, RESERVADO_PADRAO),
      origem_ponta: eq.numero_uc || eq.concessionaria ? { numero_uc: eq.numero_uc, concessionaria: eq.concessionaria } : null,
      motobomba_equipamento_id: row?.motobomba_equipamento_id ?? null,
      parametros: {
        pressao_minima: num(parametros.pressao_minima),
        lamina_100: num(parametros.lamina_100),
        tempo_volta_100: num(parametros.tempo_volta_100),
        percentimetro_ciclo_s: num(parametros.percentimetro_ciclo_s),
        correcao_angulo_zero: num(parametros.correcao_angulo_zero),
        encoder_equipamento_id: typeof parametros.encoder_equipamento_id === 'string' && parametros.encoder_equipamento_id.trim()
          ? parametros.encoder_equipamento_id.trim() : null,
        encoder_resolucao: num(parametros.encoder_resolucao),
        encoder_invertido: parametros.encoder_invertido === true,
        direcionamento: parametros.direcionamento === 'fisico' ? 'fisico' : 'valvula',
        valvula_ton_id: typeof parametros.valvula_ton_id === 'string' ? parametros.valvula_ton_id : null,
        valvula_bo: num(parametros.valvula_bo),
      },
      unidade_nome: eq.unidade_nome ?? null,
      planta_nome: eq.planta_nome ?? null,
      proprietario_nome: eq.proprietario_nome ?? null,
      updated_at: row?.updated_at ?? null,
    };
  }

  async putConfig(equipamentoId: string, dto: PivoConfigDto, user?: ScopedUser & { permissions?: string[] }) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const atual = await this.getConfig(eq.id, user);

    // PER-33a: lâmina, ponta e reservado são operacionais (todos com acesso);
    // pressão, tempo de volta, ângulo zero, válvula e motobomba são técnicos.
    if (user && !capacidades(papelCanonico(user.role)).configTecnica) {
      if (camposTecnicosAlterados(dto, atual).length) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
    }

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
    // Encoder: equipamento da MESMA instalação do pivô (escopo do dono).
    const encId = dto.parametros?.encoder_equipamento_id;
    if (typeof encId === 'string' && encId.trim()) {
      const enc = await this.carregarEquipamento(encId, user);
      if (enc.id === eq.id) throw new BadRequestException('O pivô não pode ser o próprio encoder');
      if (enc.unidade_id !== eq.unidade_id) throw new BadRequestException('O encoder tem de ser da mesma instalação do pivô');
      if (dto.parametros) dto.parametros.encoder_equipamento_id = enc.id;
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

    if (dto.parametros) {
      const novo = { ...atual.parametros, ...Object.fromEntries(Object.entries(dto.parametros).filter(([, v]) => v !== undefined)) };
      await this.escrever(() => this.prisma.$executeRaw`
        UPDATE pivo_config SET parametros = ${JSON.stringify(novo)}::jsonb, updated_at = now(), updated_by = ${user?.id?.trim() ?? null}
        WHERE equipamento_id = ${eq.id}::bpchar`);
    }

    // Trilha (logs_mqtt tipo comando): o que mudou e quem mudou.
    const mudou: string[] = [];
    if (dto.bloqueio_ponta) mudou.push(`ponta ${bloqueio.ativo ? 'bloqueada' : 'livre'} ${bloqueio.inicio}–${bloqueio.fim}`);
    if (dto.motobomba_equipamento_id !== undefined) mudou.push(`motobomba ${motobomba ?? 'nenhuma'}`);
    if (dto.parametros) {
      for (const [k, v] of Object.entries(dto.parametros)) {
        const antes = (atual.parametros as Record<string, unknown>)[k];
        if (v !== undefined && v !== antes) mudou.push(`${k} ${antes ?? '—'} → ${v ?? '—'}`);
      }
    }
    if (mudou.length) {
      try {
        await this.prisma.logs_mqtt.create({
          data: {
            tipo: 'comando', equipamento_id: eq.id, severidade: 'INFO', status: 'gravado',
            mensagem: `Configuração do pivô alterada: ${mudou.join('; ')}`.slice(0, 500),
            usuario_id: user?.id?.trim() || null, comando_semantico: 'pivo.config',
          },
        });
      } catch { /* trilha nunca derruba a gravação */ }
    }
    return this.getConfig(eq.id, user);
  }

  /**
   * Encoders da instalação do pivô (equipamento ENCODER criado pelo diagrama IoT),
   * com a última leitura bruta, para a Configuração escolher e conferir.
   */
  async opcoesEncoder(equipamentoId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    if (!eq.unidade_id) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string; nome: string; dados: any; ts: Date | null }>>`
      SELECT TRIM(e.id) AS id, e.nome, d.dados, d.timestamp_dados AS ts
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
      LEFT JOIN LATERAL (
        SELECT dados, timestamp_dados FROM equipamentos_dados x
        WHERE x.equipamento_id = e.id ORDER BY x.timestamp_dados DESC LIMIT 1
      ) d ON true
      WHERE e.unidade_id = ${eq.unidade_id}::bpchar AND e.deleted_at IS NULL
        AND (te.codigo = 'ENCODER' OR UPPER(TRIM(e.tipo_equipamento)) = 'ENCODER')
      ORDER BY e.nome`;
    return rows.map((r) => ({ id: r.id, nome: r.nome?.trim() ?? r.id, bruto: brutoDoEncoder(r.dados), lido_em: r.ts }));
  }

  // ==========================================================================
  // Programações (executadas pelo PivoAutomacaoService)
  // ==========================================================================

  async listarProgramacoes(equipamentoId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    try {
      const rows = await this.prisma.$queryRaw<ProgramacaoRow[]>`
        SELECT ${PROG_COLS}
        FROM pivo_programacoes
        WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND data IS NULL
        ORDER BY hora_inicio, nome`;   // só as semanais: a agenda por data tem a rota dela (/agenda)
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
         sentido, velocidade, com_agua, canhao, created_by, updated_by, created_at, updated_at)
      VALUES
        (${id}, ${eq.id}, ${p.nome}, ${p.ativo}, ${p.hora_inicio}, ${p.dias}::smallint[], ${p.modo},
         ${p.angulo_inicial}, ${p.angulo_final}, ${p.duracao_min}, ${p.sentido}, ${p.velocidade}, ${p.com_agua},
         ${p.canhao}, ${uid}, ${uid}, now(), now())`);
    await this.auditarAgenda(eq.id, `Horário programado: ${p.nome}${p.canhao ? ' · canhão' : ''}`, user);
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
        com_agua = ${p.com_agua},
        canhao = CASE WHEN ${p.com_agua} THEN COALESCE(${dto.canhao ?? null}::boolean, canhao) ELSE false END,
        updated_by = ${user?.id?.trim() ?? null}, updated_at = now()
      WHERE TRIM(id) = ${progId.trim()} AND equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND data IS NULL`);
    if (!n) throw new NotFoundException('Programação não encontrada');
    const salvo = await this.buscarProgramacao(eq.id, progId.trim());
    await this.auditarAgenda(eq.id, `Horário programado alterado: ${p.nome}${salvo.canhao ? ' · canhão' : ''}`, user);
    return salvo;
  }

  async removerProgramacao(equipamentoId: string, progId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const antes = await this.prisma.$queryRaw<Array<{ nome: string }>>`
      SELECT nome FROM pivo_programacoes WHERE TRIM(id) = ${progId.trim()} AND equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL`.catch(() => []);
    const n = await this.escrever(() => this.prisma.$executeRaw`
      UPDATE pivo_programacoes SET deleted_at = now(), updated_by = ${user?.id?.trim() ?? null}, updated_at = now()
      WHERE TRIM(id) = ${progId.trim()} AND equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL`);
    if (!n) throw new NotFoundException('Programação não encontrada');
    await this.auditarAgenda(eq.id, `Horário programado removido: ${antes[0]?.nome ?? progId.trim()}`, user);
    return { ok: true, id: progId.trim() };
  }

  // ==========================================================================
  // Agenda por data — a planilha (NEXON-98). Cada linha é uma programação com `data`.
  // ==========================================================================

  /** Trilha da agenda em logs_mqtt (comando_semantico 'pivo.agenda'): quem programou o quê. Nunca derruba a gravação. */
  private async auditarAgenda(equipamentoId: string, mensagem: string, user?: ScopedUser) {
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: equipamentoId, severidade: 'INFO', status: 'gravado',
          mensagem: mensagem.slice(0, 500), usuario_id: user?.id?.trim() || null, comando_semantico: 'pivo.agenda',
        },
      });
    } catch { /* trilha nunca derruba a gravação */ }
  }

  /** O que está agendado por data, de hoje em diante (ou no intervalo pedido). */
  async listarAgenda(equipamentoId: string, q: { de?: string; ate?: string } = {}, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    const hoje = agoraEmSaoPaulo().data;
    const de = lerData(q.de) ?? hoje;   // data impossível (2026-13-45) cai em hoje, não em erro 500
    const ate = lerData(q.ate);
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; data: string; hora_inicio: string; duracao_min: number | null; sentido: string; velocidade: unknown; com_agua: boolean; canhao: boolean; lote_id: string | null; executada: boolean }>>`
        SELECT TRIM(id) AS id, to_char(data, 'YYYY-MM-DD') AS data, hora_inicio, duracao_min, sentido, velocidade, com_agua,
               COALESCE((to_jsonb(pivo_programacoes)->>'canhao')::boolean, false) AS canhao,
               TRIM(lote_id) AS lote_id, (ultima_execucao_em IS NOT NULL) AS executada
        FROM pivo_programacoes
        WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND data IS NOT NULL
          AND data >= ${de}::date AND (${ate}::date IS NULL OR data <= ${ate}::date)
        ORDER BY data, hora_inicio
        LIMIT 2000`;
      return {
        de, ate, total: rows.length,
        itens: rows.map((r) => ({ ...r, duracao_min: r.duracao_min === null ? null : Number(r.duracao_min), velocidade: num(r.velocidade) })),
      };
    } catch (e) {
      if (colunaTrilhaAusente(e)) return { de, ate, total: 0, itens: [] };
      throw e;
    }
  }

  /**
   * Sobe a planilha. Confere TODAS as linhas antes de gravar: uma linha errada recusa o envio
   * inteiro, com o motivo de cada uma — agenda pela metade é pior que nenhuma. `substituir`
   * apaga o que estava agendado por data de hoje em diante antes de gravar o novo.
   */
  async importarAgenda(equipamentoId: string, body: { itens?: unknown; substituir?: boolean }, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const agora = agoraEmSaoPaulo();
    const substituir = body?.substituir === true;
    const cfg = await this.prisma.$queryRaw<Array<{ bloqueio_ponta: unknown }>>`
      SELECT bloqueio_ponta FROM pivo_config WHERE equipamento_id = ${eq.id}::bpchar LIMIT 1`.catch(() => []);
    const ponta = janelaOuPadrao(cfg[0]?.bloqueio_ponta, PONTA_PADRAO);
    // O que fica no pivô e não pode ser sobreposto: sem `substituir`, a agenda por data que já existe.
    const ocupados = substituir ? [] : await this.escrever(() => this.prisma.$queryRaw<Ocupado[]>`
      SELECT to_char(data, 'YYYY-MM-DD') AS data, hora_inicio, duracao_min FROM pivo_programacoes
      WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND ativo AND data IS NOT NULL AND data >= ${agora.data}::date - 7`);
    const { ok, erros } = validarAgenda(body?.itens, agora, ponta, ocupados);
    if (erros.length) {
      const amostra = erros.slice(0, 15).map((e) => (e.linha ? `Linha ${e.linha}: ${e.motivo}` : e.motivo)).join(' ');
      throw new BadRequestException(`Planilha recusada, nada foi gravado. ${erros.length} ${erros.length === 1 ? 'problema' : 'problemas'}: ${amostra}${erros.length > 15 ? ' …' : ''}`);
    }
    const lote = novoId26();
    const uid = user?.id?.trim() ?? null;
    let removidos = 0;
    await this.escrever(() => this.prisma.$transaction(async (tx) => {
      if (substituir) {
        removidos = await tx.$executeRaw`
          UPDATE pivo_programacoes SET deleted_at = now(), updated_by = ${uid}, updated_at = now()
          WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND data IS NOT NULL AND data >= ${agora.data}::date`;
      }
      for (let i = 0; i < ok.length; i += 500) {
        const linhas = ok.slice(i, i + 500).map((x) => Prisma.sql`
          (${novoId26()}, ${eq.id}, ${x.nome}, true, ${x.hora_inicio}, '{}'::smallint[], 'tempo', ${x.duracao_min},
           ${x.sentido}, ${x.velocidade}, ${x.com_agua}, ${x.canhao}, ${x.data}::date, ${lote}, ${uid}, ${uid}, now(), now())`);
        await tx.$executeRaw`
          INSERT INTO pivo_programacoes
            (id, equipamento_id, nome, ativo, hora_inicio, dias, modo, duracao_min, sentido, velocidade, com_agua, canhao, data, lote_id,
             created_by, updated_by, created_at, updated_at)
          VALUES ${Prisma.join(linhas)}`;
      }
    }));
    // `dias` vazio de propósito: uma versão antiga do servidor (rollback, staging no mesmo banco)
    // não conhece `data` e dispararia a linha TODO dia; com `dias` vazio ela nunca dispara lá.
    const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const datas = ok.map((x) => x.data).sort();
    const comCanhao = ok.filter((x) => x.canhao).length;
    await this.auditarAgenda(eq.id,
      `Agenda por planilha: ${ok.length} ${ok.length === 1 ? 'irrigação' : 'irrigações'} de ${br(datas[0])} a ${br(datas[datas.length - 1])}`
      + `${comCanhao ? ` · ${comCanhao} com canhão` : ''}`
      + `${substituir ? ` · substituiu ${removidos} que estavam agendadas` : ''} · lote ${lote}`, user);
    return { ok: true, lote_id: lote, gravados: ok.length, com_canhao: comCanhao, removidos, de: datas[0], ate: datas[datas.length - 1] };
  }

  /** Apaga a agenda por data de hoje em diante (as semanais ficam). */
  async limparAgenda(equipamentoId: string, user?: ScopedUser) {
    const eq = await this.carregarEquipamento(equipamentoId, user);
    await this.exigirComandoNaUnidade(eq.unidade_id, user);
    const hoje = agoraEmSaoPaulo().data;
    const n = await this.escrever(() => this.prisma.$executeRaw`
      UPDATE pivo_programacoes SET deleted_at = now(), updated_by = ${user?.id?.trim() ?? null}, updated_at = now()
      WHERE equipamento_id = ${eq.id}::bpchar AND deleted_at IS NULL AND data IS NOT NULL AND data >= ${hoje}::date`);
    if (n) await this.auditarAgenda(eq.id, `Agenda por data apagada: ${n} ${n === 1 ? 'irrigação' : 'irrigações'} de hoje em diante`, user);
    return { ok: true, removidos: n };
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
      // Operador: só os pivôs liberados a ele entram no grupo (PER-23).
      const eqs = user ? await this.scope.getEquipamentosScope(user) : null;
      return agruparConjugados(eqs ? linhas.filter((l) => eqs.includes(l.pivo_id.trim())) : linhas);
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
      unidade_nome: string | null; planta_nome: string | null; proprietario_nome: string | null;
    }>>`
      SELECT TRIM(e.id) AS id, e.nome, TRIM(un.id) AS unidade_id, un.numero_uc, ce.nome AS concessionaria,
             un.nome AS unidade_nome, pl.nome AS planta_nome, us.nome AS proprietario_nome
      FROM equipamentos e
      LEFT JOIN equipamentos pai ON pai.id = e.equipamento_pai_id
      LEFT JOIN unidades un ON un.id = COALESCE(e.unidade_id, pai.unidade_id)
      LEFT JOIN concessionarias_energia ce ON ce.id = un.concessionaria_id
      LEFT JOIN plantas pl ON pl.id = un.planta_id
      LEFT JOIN usuarios us ON us.id = pl.proprietario_id
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
   *
   * NEXON-20 (6.2): Admin, analistas e proprietário comandam tudo do próprio
   * escopo; o recorte do operador é o equipamento liberado (assertEntityInScope).
   * A tabela legada só vale para os demais papéis e pode nem existir.
   */
  private async exigirComandoNaUnidade(unidadeId: string | null, user?: ScopedUser) {
    const userId = user?.id?.trim();
    if (!userId) return;
    const papel = papelCanonico(user?.role);
    if (isGlobal(papel) || papel === 'proprietario') return;
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
      // sem água o canhão não liga (mesma regra do Ligar)
      canhao: dto.canhao === true && (dto.com_agua ?? true),
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
      canhao: r.canhao === true,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}
