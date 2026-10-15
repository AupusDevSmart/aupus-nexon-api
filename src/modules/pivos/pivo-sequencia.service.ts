import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser, ClienteInfo } from '@/core';
import { novoId26 } from '../../core/common/cliente-info';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import { FUSO_OPERACAO, JanelaComAtivo, janelaValida, momentoEmSaoPaulo } from '../../shared/util/janela-horario';
import { dentroDaPonta, duracaoParadaMs, Irrigacao, normalizarIrrigacao, OrigemSequencia, resumoIrrigacao } from './pivo-automacao.util';

/**
 * Sequência do pivô com bombeamento (docs/IOT-PIVO-BOMBEAMENTO.md).
 *
 * O pivô e a bomba ficam em TONs diferentes; só o NexON enxerga as duas. Um clique
 * ("Girar ←/→" ou "Desligar") vira a sequência inteira:
 *
 *   Girar:    bomba já ligada? (BI) ── não → liga bomba → confirma BI → aguarda pressurização
 *             → pulso Girar_X no pivô → confirma status "Girando_X"
 *   Desligar: pulso Desligar no pivô → confirma parado → desliga a bomba SÓ se nenhum
 *             outro pivô da mesma bomba (mesma TON + BO de ligar) estiver girando
 *
 * Bombeamento = funcionalidade do pivô (pivo_config.bombeamento), não equipamento.
 * Comandos do pivô vão pelo acionarPonto (permissão, janela, ponta, trilha); os da bomba
 * pelo acionarBoDireto (mesmas restrições, trilha no pivô). Estado persistido em
 * pivo_sequencias; a ficha acompanha por GET /pivos/:id/estado.
 */

export type AcaoPivo = 'girar_direita' | 'girar_esquerda' | 'desligar';

export interface Bombeamento {
  ativo: boolean;
  ton_id: string;
  modo: 'pulso' | 'mantido';
  bo_liga: number;
  bo_desliga?: number | null;
  bi_confirma?: number | null;
  confirma_s?: number;
  pulso_ms?: number;
}
export interface SequenciaCfg { pressurizacao_s: number; confirma_giro_s: number }
export interface AcionarOpts {
  irrigacao?: unknown;
  origem?: OrigemSequencia;
  /** autor da trilha quando quem age é o servidor (dono da programação, quem ligou antes da ponta) */
  responsavelId?: string | null;
  /** texto extra na trilha ("parada por 2 voltas", "início da ponta 18:00") */
  motivo?: string;
  /** desligar da ponta: o que retomar ao fim dela */
  retomar?: { irrigacao: Irrigacao | null; acao: AcaoPivo; restante_ms: number | null } | null;
}

interface Passo { t: string; etapa: string; msg: string; ok: boolean | null }
type Autor = ScopedUser & { nome?: string };

const SEQ_PADRAO: SequenciaCfg = { pressurizacao_s: 120, confirma_giro_s: 30 };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Pontos do pivô por papel, achados pelo nome (Girar_direita, Girando_esquerda, Desligado, Erro…). */
const PAPEIS_COMANDO: Record<'direita' | 'esquerda' | 'desligar', RegExp> = {
  direita: /direit|horario(?!.*anti)/,
  esquerda: /esquerd|anti.?horario/,
  desligar: /deslig|parar|stop/,
};
const PAPEIS_STATUS: Record<'direita' | 'esquerda' | 'desligado' | 'erro', RegExp> = {
  direita: /direit/,
  esquerda: /esquerd/,
  desligado: /deslig|parad/,
  erro: /erro|falha/,
};

@Injectable()
export class PivoSequenciaService implements OnModuleInit {
  private readonly logger = new Logger(PivoSequenciaService.name);
  /** sequências em execução neste processo: pivoId → flag de cancelamento */
  private readonly rodando = new Map<string, { seqId: string; cancelar: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly cmd: EquipamentosCmdService,
  ) {}

  async onModuleInit() {
    // processo reiniciou no meio de uma sequência: não há como retomar com segurança
    await this.prisma.$executeRaw`
      UPDATE pivo_sequencias SET status = 'interrompida', finished_at = now(),
        erro = COALESCE(erro, 'Servidor reiniciado durante a sequência')
      WHERE status = 'executando'`.catch(() => undefined);
  }

  // ------------------------------------------------------------------ config
  async lerConfig(pivoId: string): Promise<{ bombeamento: Bombeamento | null; sequencia: SequenciaCfg }> {
    const rows = await this.prisma.$queryRaw<Array<{ bombeamento: any; sequencia: any }>>`
      SELECT bombeamento, sequencia FROM pivo_config WHERE equipamento_id = ${pivoId}::bpchar LIMIT 1`;
    const b = rows[0]?.bombeamento;
    const s = rows[0]?.sequencia ?? {};
    return {
      bombeamento: b && b.ton_id && b.bo_liga ? (b as Bombeamento) : null,
      sequencia: {
        pressurizacao_s: Number.isFinite(Number(s.pressurizacao_s)) ? Number(s.pressurizacao_s) : SEQ_PADRAO.pressurizacao_s,
        confirma_giro_s: Number(s.confirma_giro_s) || SEQ_PADRAO.confirma_giro_s,
      },
    };
  }

  async salvarConfig(pivoId: string, body: { bombeamento?: Partial<Bombeamento> | null; sequencia?: Partial<SequenciaCfg> }, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    let bomb: Bombeamento | null = null;
    if (body.bombeamento && body.bombeamento.ativo !== false) {
      const b = body.bombeamento;
      const inteiro = (v: any, nome: string, obrig = false) => {
        if (v === null || v === undefined || v === '') {
          if (obrig) throw new BadRequestException(`Bombeamento: informe ${nome}.`);
          return null;
        }
        const n = Math.trunc(Number(v));
        if (!(n >= 1 && n <= 16)) throw new BadRequestException(`Bombeamento: ${nome} inválido (${v}).`);
        return n;
      };
      if (!b.ton_id) throw new BadRequestException('Bombeamento: escolha a TON da bomba.');
      const ton = await this.prisma.equipamentos.findFirst({ where: { id: String(b.ton_id).trim(), deleted_at: null }, select: { id: true } });
      if (!ton) throw new BadRequestException('Bombeamento: TON não encontrada.');
      if (user) await this.scope.assertEntityInScope('equipamento', ton.id.trim(), user);
      const modo = b.modo === 'mantido' ? 'mantido' : 'pulso';
      bomb = {
        ativo: true,
        ton_id: ton.id.trim(),
        modo,
        bo_liga: inteiro(b.bo_liga, 'a BO de ligar', true)!,
        bo_desliga: modo === 'pulso' ? inteiro(b.bo_desliga, 'a BO de desligar', true) : null,
        bi_confirma: inteiro(b.bi_confirma, 'a BI de confirmação'),
        confirma_s: Math.max(5, Math.min(300, Number(b.confirma_s) || 30)),
        pulso_ms: Math.max(100, Math.min(10000, Number(b.pulso_ms) || 1000)),
      };
      if (bomb.modo === 'pulso' && bomb.bo_desliga === bomb.bo_liga) {
        throw new BadRequestException('Bombeamento por pulso: a BO de desligar tem de ser diferente da de ligar.');
      }
    }
    const atual = await this.lerConfig(id);
    const seq: SequenciaCfg = {
      pressurizacao_s: Math.max(0, Math.min(900, Number(body.sequencia?.pressurizacao_s ?? atual.sequencia.pressurizacao_s))),
      confirma_giro_s: Math.max(5, Math.min(300, Number(body.sequencia?.confirma_giro_s ?? atual.sequencia.confirma_giro_s))),
    };
    const bombJson = body.bombeamento === undefined ? (atual.bombeamento ? JSON.stringify(atual.bombeamento) : null) : bomb ? JSON.stringify(bomb) : null;
    await this.prisma.$executeRaw`
      INSERT INTO pivo_config (equipamento_id, bombeamento, sequencia, updated_at, updated_by)
      VALUES (${id}::bpchar, ${bombJson}::jsonb, ${JSON.stringify(seq)}::jsonb, now(), ${user?.id?.trim() || null})
      ON CONFLICT (equipamento_id) DO UPDATE SET bombeamento = EXCLUDED.bombeamento, sequencia = EXCLUDED.sequencia,
        updated_at = now(), updated_by = EXCLUDED.updated_by`;
    return this.estado(id, user);
  }

  /** TONs da mesma planta (para escolher a da bomba) + bombeamentos de outros pivôs (atalho "usar o do Pivô X"). */
  async opcoes(pivoId: string, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    const tons = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(t.id) AS id, TRIM(t.nome) AS nome, TRIM(t.topico_mqtt) AS topico, TRIM(u.nome) AS unidade
      FROM equipamentos p
      JOIN unidades up ON up.id = p.unidade_id
      JOIN unidades u ON u.planta_id = up.planta_id AND u.deleted_at IS NULL
      JOIN equipamentos t ON t.unidade_id = u.id AND t.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos te ON te.id = t.tipo_equipamento_id
      WHERE p.id = ${id}::bpchar
        AND (te.codigo ILIKE 'TON%' OR t.tipo_equipamento ILIKE 'TON%')
      ORDER BY u.nome, t.nome`;
    const outros = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS pivo_id, TRIM(e.nome) AS nome, c.bombeamento
      FROM pivo_config c
      JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      JOIN unidades u ON u.id = e.unidade_id
      WHERE c.bombeamento IS NOT NULL AND c.equipamento_id <> ${id}::bpchar
        AND u.planta_id = (SELECT u2.planta_id FROM equipamentos p2 JOIN unidades u2 ON u2.id = p2.unidade_id WHERE p2.id = ${id}::bpchar)
      ORDER BY e.nome`;
    return { tons, bombeamentos: outros };
  }

  // ------------------------------------------------------------------ estado
  async estado(pivoId: string, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    const cfg = await this.lerConfig(id);
    const pts = await this.pontos(id);
    const st = await this.statusPivo(pts);
    let bomba: any = null;
    if (cfg.bombeamento) {
      const b = cfg.bombeamento;
      const ton = await this.prisma.equipamentos.findFirst({ where: { id: b.ton_id }, select: { nome: true, deleted_at: true } });
      const ligada = b.bi_confirma ? await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma) : null;
      const comp = await this.companheiros(id, b);
      bomba = {
        ...b,
        ton_nome: ton?.nome?.trim() ?? null,
        ton_removida: !ton || !!ton.deleted_at,
        ligada: ligada?.valor ?? null,
        ligada_em: ligada?.updated_at ?? null,
        compartilhada_com: comp.map((c) => c.nome),
      };
    }
    const seq = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, acao, status, passos, erro, created_at, finished_at, origem, irrigacao, parar_em
      FROM pivo_sequencias WHERE equipamento_id = ${id}::bpchar AND status NOT IN ('agendada', 'cancelada')
      ORDER BY created_at DESC LIMIT 1`;
    const agendada = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, acao, irrigacao, inicio_em FROM pivo_sequencias
      WHERE equipamento_id = ${id}::bpchar AND status = 'agendada' ORDER BY inicio_em LIMIT 1`;
    // Última irrigação enviada (para "Carregar última irrigação" e o texto do status).
    const ultima = await this.prisma.$queryRaw<any[]>`
      SELECT irrigacao FROM pivo_sequencias WHERE equipamento_id = ${id}::bpchar AND irrigacao IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`;
    // Pausada pela ponta: última sequência é o desligar da ponta com algo a retomar.
    const pausa = seq[0]?.acao === 'desligar' && seq[0]?.origem === 'ponta'
      ? await this.lerPonta(id) : null;
    const ativa = await this.irrigacaoAtiva(id);
    return {
      pivo: {
        comandos: { direita: !!pts.cmd.direita, esquerda: !!pts.cmd.esquerda, desligar: !!pts.cmd.desligar },
        status: st,
      },
      bombeamento: bomba,
      sequencia_cfg: cfg.sequencia,
      sequencia: seq[0] ?? null,
      irrigacao: {
        ativa: !!ativa,
        atual: ativa?.irrigacao ?? null,
        parar_em: ativa?.parar_em ?? null,
        ultima: ultima[0]?.irrigacao ?? null,
        agendada: agendada[0] ? { id: agendada[0].id, acao: agendada[0].acao, irrigacao: agendada[0].irrigacao, inicio_em: agendada[0].inicio_em } : null,
        pausada_ponta: pausa ? { retoma_as: pausa.fim } : null,
        bomba_em_uso_por: cfg.bombeamento ? await this.bombaEmUsoPor(id, cfg.bombeamento) : null,
      },
    };
  }

  // ------------------------------------------------------------------ acionar
  /**
   * `opts.irrigacao` = o que a "Irrigação avançada" mandou (direção, %, sem água,
   * canhão, parada, início). Início no futuro vira sequência 'agendada' que o
   * PivoAutomacaoService dispara. `origem` ≠ manual = o servidor agindo sozinho
   * (programação, ponta, parada); `responsavelId` = quem programou/ligou, para a trilha.
   */
  async acionar(pivoId: string, acao: AcaoPivo, user?: Autor, cliente?: ClienteInfo, opts: AcionarOpts = {}) {
    if (!['girar_direita', 'girar_esquerda', 'desligar'].includes(acao)) {
      throw new BadRequestException('Ação inválida (girar_direita | girar_esquerda | desligar).');
    }
    const origem: OrigemSequencia = opts.origem ?? 'manual';
    const id = await this.assertPivo(pivoId, user);
    const eq = await this.prisma.equipamentos.findFirst({ where: { id }, select: { nome: true, automacao: true } });
    if (!eq?.automacao) throw new BadRequestException(`"${eq?.nome?.trim()}" não tem automação habilitada.`);
    const pts = await this.pontos(id);
    const papel = acao === 'girar_direita' ? 'direita' : acao === 'girar_esquerda' ? 'esquerda' : 'desligar';
    const cfg = await this.lerConfig(id);
    if (!pts.cmd[papel] && !(acao === 'desligar' && cfg.bombeamento)) {
      throw new BadRequestException(`O pivô não tem o comando "${papel}" cadastrado (ponto de comando ligado a uma BO).`);
    }
    const autorId = user?.id?.trim() || opts.responsavelId?.trim() || null;
    let irrigacao = acao === 'desligar' ? null : normalizarIrrigacao(opts.irrigacao);
    if (irrigacao) irrigacao.config.direcao = acao === 'girar_direita' ? 'Avanço' : 'Reverso';

    if (acao === 'desligar') {
      // Desligar cancela também o que estava agendado.
      const n = await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET status = 'cancelada', finished_at = now(), erro = 'Cancelada pelo Desligar'
        WHERE equipamento_id = ${id}::bpchar AND status = 'agendada'`;
      if (n) await this.trilha(id, `Início agendado cancelado pelo Desligar`, autorId, origem);
    } else {
      const ponta = await this.lerPonta(id);
      if (origem !== 'ponta_retomada' && dentroDaPonta(ponta, momentoEmSaoPaulo())) {
        throw new BadRequestException(`Horário de ponta (${ponta!.inicio}–${ponta!.fim}): o pivô pode ligar a partir das ${ponta!.fim}. Use "Início" na Irrigação avançada para agendar.`);
      }
      // Sistema conjugado: um pivô por vez na mesma bomba (com água).
      if (cfg.bombeamento && !irrigacao?.config.semAgua) {
        const uso = await this.bombaEmUsoPor(id, cfg.bombeamento);
        if (uso) throw new ConflictException(`Bomba em uso pelo ${uso}. Desligue o ${uso} antes de ligar este pivô.`);
      }
      // Início no futuro: agenda (o tick dispara).
      const ini = irrigacao?.inicio ? new Date(irrigacao.inicio) : null;
      if (ini && ini.getTime() - Date.now() > 60000 && origem === 'manual') {
        await this.prisma.$executeRaw`
          UPDATE pivo_sequencias SET status = 'cancelada', finished_at = now(), erro = 'Substituída por novo agendamento'
          WHERE equipamento_id = ${id}::bpchar AND status = 'agendada'`;
        const seqId = novoId26();
        await this.prisma.$executeRaw`
          INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, usuario_id, origem, irrigacao, inicio_em)
          VALUES (${seqId}, ${id}::bpchar, ${acao}, 'agendada', ${autorId}, 'agendada', ${JSON.stringify(irrigacao)}::jsonb, ${ini})`;
        await this.trilha(id, `Irrigação agendada para ${ini.toLocaleString('pt-BR', { timeZone: FUSO_OPERACAO })}: ${resumoIrrigacao(irrigacao)}`, autorId, origem);
        return { sequencia_id: seqId, status: 'agendada', inicio_em: ini.toISOString() };
      }
      if (irrigacao) irrigacao = { ...irrigacao, inicio: null };
    }

    const atual = this.rodando.get(id);
    if (atual) {
      if (acao !== 'desligar') throw new ConflictException('Já existe uma sequência em andamento neste pivô. Use Desligar para interromper.');
      atual.cancelar = true;   // Desligar sempre pode: interrompe a partida em curso
      for (let i = 0; i < 40 && this.rodando.has(id); i++) await this.sleep(250);
    }

    const seqId = novoId26();
    await this.prisma.$executeRaw`
      INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, usuario_id, origem, irrigacao, retomar)
      VALUES (${seqId}, ${id}::bpchar, ${acao}, 'executando', ${autorId}, ${origem},
        ${irrigacao ? JSON.stringify(irrigacao) : null}::jsonb, ${opts.retomar ? JSON.stringify(opts.retomar) : null}::jsonb)`;
    await this.trilha(id, acao === 'desligar'
      ? `Desligar${opts.motivo ? ` · ${opts.motivo}` : ''}`
      : `Ligar · ${resumoIrrigacao(irrigacao)}${opts.motivo ? ` · ${opts.motivo}` : ''}`, autorId, origem);
    const ctl = { seqId, cancelar: false };
    this.rodando.set(id, ctl);
    void this.executar(id, acao, ctl, user, cliente, irrigacao).finally(() => {
      if (this.rodando.get(id) === ctl) this.rodando.delete(id);
    });
    return { sequencia_id: seqId, status: 'executando' };
  }

  // ------------------------------------------------------------- automação (apoio)
  /**
   * Irrigação em curso: a última sequência (fora agendada/cancelada) é um girar que
   * terminou bem ou está executando, e o status da TON (se houver) não diz parado.
   */
  async irrigacaoAtiva(id: string): Promise<null | { id: string; acao: AcaoPivo; irrigacao: Irrigacao | null; parar_em: Date | null; usuario_id: string | null; created_at: Date }> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, acao, status, irrigacao, parar_em, TRIM(usuario_id) AS usuario_id, created_at
      FROM pivo_sequencias WHERE equipamento_id = ${id}::bpchar AND status NOT IN ('agendada', 'cancelada')
      ORDER BY created_at DESC LIMIT 1`;
    const r = rows[0];
    if (!r || r.acao === 'desligar' || !['executando', 'concluida'].includes(r.status)) return null;
    const st = await this.statusPivo(await this.pontos(id));
    if (r.status === 'concluida' && (st.desligado === 1 || (st.direita === 0 && st.esquerda === 0))) return null;
    return { id: r.id, acao: r.acao, irrigacao: r.irrigacao ?? null, parar_em: r.parar_em ?? null, usuario_id: r.usuario_id ?? null, created_at: r.created_at };
  }

  /** Nome do outro pivô da mesma bomba que está irrigando (com água), ou null. */
  async bombaEmUsoPor(id: string, b: Bombeamento): Promise<string | null> {
    for (const c of await this.companheiros(id, b)) {
      const s = await this.statusPivo(await this.pontos(c.id));
      if (s.direita === 1 || s.esquerda === 1 || this.rodando.has(c.id)) return c.nome;
      const at = await this.irrigacaoAtiva(c.id);
      if (at && !at.irrigacao?.config?.semAgua) return c.nome;
    }
    return null;
  }

  async lerPonta(id: string): Promise<JanelaComAtivo | null> {
    const rows = await this.prisma.$queryRaw<Array<{ bloqueio_ponta: unknown }>>`
      SELECT bloqueio_ponta FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`.catch(() => []);
    const j = rows[0]?.bloqueio_ponta;
    return janelaValida(j) ? (j as JanelaComAtivo) : null;
  }

  /** Ângulo lido na telemetria (última leitura até 15 min), ou null. */
  async anguloAtual(id: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ dados: any }>>`
      SELECT dados FROM equipamentos_dados WHERE equipamento_id = ${id}::bpchar
        AND timestamp_dados > now() - interval '15 minutes'
      ORDER BY timestamp_dados DESC LIMIT 1`.catch(() => []);
    const d = rows[0]?.dados;
    const v = Number(d?.angulo ?? d?.posicao ?? d?.data?.angulo);
    return d && Number.isFinite(v) ? v : null;
  }

  /** Tempo de volta a 100% (h) da Configuração; padrão 21 h. */
  async tempoVolta100(id: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ parametros: any }>>`
      SELECT parametros FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`.catch(() => []);
    const v = Number(rows[0]?.parametros?.tempo_volta_100);
    return v >= 1 ? v : 21;
  }

  /**
   * Trilha (audit log) da automação do pivô em logs_mqtt tipo 'comando',
   * comando_semantico 'pivo.<origem>' — busca por equipamento, autor e origem.
   */
  async trilha(id: string, mensagem: string, usuarioId: string | null, origem: OrigemSequencia, severidade = 'INFO') {
    const rotulo: Record<OrigemSequencia, string> = {
      manual: '', agendada: 'Agendamento', programacao: 'Programação', ponta: 'Horário de ponta', ponta_retomada: 'Fim da ponta', parada: 'Parada automática',
    };
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: id, severidade, status: 'gravado',
          mensagem: `${rotulo[origem] ? `${rotulo[origem]}: ` : ''}${mensagem}`.slice(0, 500),
          usuario_id: usuarioId, comando_semantico: `pivo.${origem}`,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[pivo-trilha] ${id}: ${e?.message}`);
    }
  }

  // ------------------------------------------------------------------ execução
  private async executar(id: string, acao: AcaoPivo, ctl: { seqId: string; cancelar: boolean }, user?: Autor, cliente?: ClienteInfo, irr: Irrigacao | null = null) {
    const passos: Passo[] = [];
    const passo = async (etapa: string, msg: string, ok: boolean | null) => {
      passos.push({ t: new Date().toISOString(), etapa, msg, ok });
      await this.prisma.$executeRaw`UPDATE pivo_sequencias SET passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const fim = async (status: 'concluida' | 'falhou' | 'interrompida', erro?: string) => {
      await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET status = ${status}, erro = ${erro ?? null}, finished_at = now(),
          passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const msgErro = (e: any) => e?.response?.message || e?.message || String(e);

    try {
      const cfg = await this.lerConfig(id);
      const pts = await this.pontos(id);
      const b = cfg.bombeamento;

      if (acao === 'desligar') {
        if (pts.cmd.desligar) {
          await this.cmd.acionarPonto(id, pts.cmd.desligar, user, false, undefined, cliente);
          await passo('pivo', 'Comando Desligar enviado ao pivô', true);
          const parou = await this.esperar(async () => {
            const s = await this.statusPivo(pts);
            if (s.desligado === 1) return true;
            if (s.direita === 0 && s.esquerda === 0) return true;
            return s.desligado === null && s.direita === null && s.esquerda === null ? null : false;
          }, cfg.sequencia.confirma_giro_s, ctl);
          await passo('pivo', parou === null ? 'Pivô sem status cadastrado — sem confirmação' : parou ? 'Pivô parado' : 'Pivô não confirmou parada no tempo', parou !== false);
        }
        if (b) await this.desligarBomba(id, b, passo, user, cliente);
        await this.valvula(id, false, passo, user, cliente);
        await fim('concluida');
        return;
      }

      // ---- girar
      const sentido = acao === 'girar_direita' ? 'direita' : 'esquerda';
      const st0 = await this.statusPivo(pts);
      if (st0.erro === 1) throw new Error('Pivô sinalizando ERRO — verifique no painel antes de partir.');

      let liguei = false;
      if (irr?.config.semAgua) {
        await passo('bomba', 'Girar sem água: a bomba não liga', true);
      } else {
        await this.valvula(id, true, passo, user, cliente);
      }
      if (irr && !irr.config.semAgua) {
        await passo('pivo', `Percentímetro ${irr.config.percentual}%${irr.config.canhao ? ' · canhão final ligado' : ''} (ajuste do painel do pivô)`, null);
      }
      if (b && !irr?.config.semAgua) {
        const ligada = b.bi_confirma ? (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma)).valor : null;
        if (ligada === 1) {
          await passo('bomba', 'Bomba já ligada (sistema compartilhado) — sem esperar pressurização', true);
        } else {
          await this.cmd.acionarBoDireto(
            { equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: b.modo === 'mantido' ? 'liga' : 'pulso', pulsoMs: b.pulso_ms, rotulo: 'Ligar bomba' },
            user, cliente,
          );
          liguei = true;
          await passo('bomba', 'Comando Ligar bomba enviado', true);
          if (b.bi_confirma) {
            const ok = await this.esperar(async () => (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma!)).valor === 1, b.confirma_s ?? 30, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            if (!ok) throw new FalhaBomba(`Bomba não confirmou ligada em ${b.confirma_s ?? 30}s (BI${b.bi_confirma}).`);
            await passo('bomba', 'Bomba ligada (confirmado pela BI)', true);
          } else {
            await passo('bomba', 'Sem BI de confirmação da bomba — seguindo', null);
          }
          const pressS = cfg.sequencia.pressurizacao_s;
          if (pressS > 0) {
            await passo('pressao', `Aguardando pressurização (${pressS}s)`, null);
            await this.esperar(async () => false, pressS, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            await passo('pressao', 'Pressurização concluída', true);
          }
        }
      }

      if (ctl.cancelar) return await this.interrompida(passo, fim);
      await this.cmd.acionarPonto(id, pts.cmd[sentido]!, user, false, undefined, cliente);
      await passo('pivo', `Comando Girar ${sentido} enviado ao pivô`, true);
      const girou = await this.esperar(async () => {
        const s = await this.statusPivo(pts);
        return s[sentido] === null ? null : s[sentido] === 1;
      }, cfg.sequencia.confirma_giro_s, ctl);
      if (ctl.cancelar) return await this.interrompida(passo, fim);
      if (girou === false) {
        throw new FalhaGiro(`Pivô não confirmou "girando ${sentido}" em ${cfg.sequencia.confirma_giro_s}s.`, liguei);
      }
      await passo('pivo', girou === null ? `Sem status de giro cadastrado — comando enviado` : `Pivô girando ${sentido}`, girou === null ? null : true);
      // Parada automática (voltas/tempo/ângulo): o PivoAutomacaoService desliga em parar_em.
      if (irr && irr.parada.tipo !== 'semParar') {
        const ms = duracaoParadaMs(irr, await this.tempoVolta100(id), await this.anguloAtual(id));
        if (ms != null) {
          const pararEm = new Date(Date.now() + ms);
          await this.prisma.$executeRaw`UPDATE pivo_sequencias SET parar_em = ${pararEm} WHERE id = ${ctl.seqId}`;
          await passo('parada', `Parada automática prevista para ${pararEm.toLocaleString('pt-BR', { timeZone: FUSO_OPERACAO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`, true);
        } else {
          await passo('parada', 'Parada por ângulo sem leitura de ângulo do pivô — o servidor para quando o ângulo for lido', null);
        }
      }
      await fim('concluida');
    } catch (e: any) {
      await passo('erro', msgErro(e), false).catch(() => undefined);
      // falhou depois de ligar a bomba: não deixa bomba ligada à toa
      if ((e instanceof FalhaBomba || (e instanceof FalhaGiro && e.liguei)) && acao !== 'desligar') {
        const cfg = await this.lerConfig(id).catch(() => null);
        if (cfg?.bombeamento) await this.desligarBomba(id, cfg.bombeamento, passo, user, cliente).catch(() => undefined);
      }
      if (acao !== 'desligar' && !irr?.config.semAgua) await this.valvula(id, false, passo, user, cliente).catch(() => undefined);
      await fim('falhou', msgErro(e)).catch(() => undefined);
      this.logger.warn(`[pivo-seq] ${id} ${acao} falhou: ${msgErro(e)}`);
    }
  }

  private async interrompida(passo: (e: string, m: string, ok: boolean | null) => Promise<void>, fim: (s: any, e?: string) => Promise<void>) {
    await passo('fim', 'Interrompida pelo Desligar', null);
    await fim('interrompida');
  }

  /** Desliga a bomba se nenhum outro pivô da mesma bomba estiver girando. */
  private async desligarBomba(
    id: string, b: Bombeamento,
    passo: (e: string, m: string, ok: boolean | null) => Promise<void>,
    user?: Autor, cliente?: ClienteInfo,
  ) {
    const comp = await this.companheiros(id, b);
    const girando: string[] = [];
    for (const c of comp) {
      const s = await this.statusPivo(await this.pontos(c.id));
      if (s.direita === 1 || s.esquerda === 1 || (this.rodando.has(c.id))) girando.push(c.nome);
    }
    if (girando.length) {
      await passo('bomba', `Bomba mantida ligada: ${girando.join(', ')} ainda usando`, true);
      return;
    }
    await this.cmd.acionarBoDireto(
      b.modo === 'mantido'
        ? { equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: 'desliga', rotulo: 'Desligar bomba' }
        : { equipamentoId: id, tonId: b.ton_id, bo: b.bo_desliga!, modo: 'pulso', pulsoMs: b.pulso_ms, rotulo: 'Desligar bomba' },
      user, cliente,
    );
    await passo('bomba', 'Comando Desligar bomba enviado', true);
    if (b.bi_confirma) {
      const ok = await this.esperar(async () => (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma!)).valor === 0, b.confirma_s ?? 30, { cancelar: false });
      await passo('bomba', ok ? 'Bomba desligada (confirmado pela BI)' : `Bomba não confirmou desligada em ${b.confirma_s ?? 30}s`, !!ok);
    }
  }

  /**
   * Sistema conjugado com "Válvula pelo NexON": a saída da válvula (TON + BO da
   * Configuração) abre ao ligar com água e fecha ao desligar. Intertravamento físico
   * ou sem saída configurada → nada a fazer.
   */
  private async valvula(
    id: string, abrir: boolean,
    passo: (e: string, m: string, ok: boolean | null) => Promise<void>,
    user?: Autor, cliente?: ClienteInfo,
  ) {
    const rows = await this.prisma.$queryRaw<Array<{ parametros: any }>>`
      SELECT parametros FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`.catch(() => []);
    const p = rows[0]?.parametros;
    if (!p || p.direcionamento === 'fisico' || !p.valvula_ton_id || !(Number(p.valvula_bo) >= 1)) return;
    await this.cmd.acionarBoDireto(
      { equipamentoId: id, tonId: String(p.valvula_ton_id).trim(), bo: Number(p.valvula_bo), modo: abrir ? 'liga' : 'desliga', rotulo: abrir ? 'Abrir válvula' : 'Fechar válvula' },
      user, cliente,
    );
    await passo('valvula', `${abrir ? 'Válvula aberta' : 'Válvula fechada'} (BO${Number(p.valvula_bo)})`, true);
  }

  // ------------------------------------------------------------------ apoio
  /** Outros pivôs com a MESMA bomba (mesma TON + mesma BO de ligar). */
  private async companheiros(id: string, b: Bombeamento): Promise<Array<{ id: string; nome: string }>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome
      FROM pivo_config c JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      WHERE c.equipamento_id <> ${id}::bpchar
        AND c.bombeamento->>'ton_id' = ${b.ton_id}
        AND (c.bombeamento->>'bo_liga')::int = ${Number(b.bo_liga)}
        AND COALESCE((c.bombeamento->>'ativo')::boolean, true)`;
    return rows;
  }

  private async pontos(id: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; tipo: string; nome: string; ton_id: string | null; bi: number | null; inv: boolean | null }>>`
      SELECT TRIM(p.id) AS id, p.tipo, p.nome, TRIM(b.ton_id) AS ton_id, b.bi_numero AS bi, b.invertido AS inv
      FROM equipamento_pontos p
      LEFT JOIN ton_bi b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      WHERE p.equipamento_id = ${id}::bpchar AND p.deleted_at IS NULL AND p.ativo
      ORDER BY p.ordem, p.nome`;
    const cmd: Partial<Record<'direita' | 'esquerda' | 'desligar', string>> = {};
    const st: Partial<Record<'direita' | 'esquerda' | 'desligado' | 'erro', { ton_id: string; bi: number; inv: boolean }>> = {};
    for (const r of rows) {
      const n = norm(r.nome);
      if (r.tipo === 'comando') {
        // ordem importa: "anti-horário" antes de "horário"
        for (const k of ['esquerda', 'direita', 'desligar'] as const) if (!cmd[k] && PAPEIS_COMANDO[k].test(n)) { cmd[k] = r.id; break; }
      } else if (r.tipo === 'status' && r.ton_id && r.bi) {
        for (const k of ['erro', 'desligado', 'esquerda', 'direita'] as const) if (!st[k] && PAPEIS_STATUS[k].test(n)) { st[k] = { ton_id: r.ton_id, bi: r.bi, inv: !!r.inv }; break; }
      }
    }
    return { cmd, st };
  }

  private async statusPivo(pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }) {
    const out: Record<'direita' | 'esquerda' | 'desligado' | 'erro', 0 | 1 | null> = { direita: null, esquerda: null, desligado: null, erro: null };
    for (const k of Object.keys(out) as Array<keyof typeof out>) {
      const m = pts.st[k];
      if (!m) continue;
      const v = (await this.cmd.lerEntradaTon(m.ton_id, m.bi)).valor;
      out[k] = v === null ? null : ((m.inv ? 1 - v : v) as 0 | 1);
    }
    return out;
  }

  /** Espera a condição virar true (poll 1 s). null da condição = "não dá para saber" → devolve null já. */
  private async esperar(cond: () => Promise<boolean | null>, segundos: number, ctl: { cancelar: boolean }): Promise<boolean | null> {
    const limite = Date.now() + segundos * 1000;
    for (;;) {
      const r = await cond();
      if (r === null) return null;
      if (r) return true;
      if (ctl.cancelar || Date.now() >= limite) return false;
      await this.sleep(1000);
    }
  }

  private async assertPivo(pivoId: string, user?: Autor): Promise<string> {
    const id = String(pivoId).trim();
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    const eq = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, tipo_equipamento: true, tipo_equipamento_rel: { select: { codigo: true } } },
    });
    if (!eq) throw new NotFoundException('Pivô não encontrado');
    const cod = String(eq.tipo_equipamento_rel?.codigo ?? eq.tipo_equipamento ?? '').toUpperCase();
    if (!cod.includes('PIVO')) throw new BadRequestException('Equipamento não é um pivô.');
    return id;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

class FalhaBomba extends Error {}
class FalhaGiro extends Error {
  constructor(msg: string, readonly liguei: boolean) { super(msg); }
}
