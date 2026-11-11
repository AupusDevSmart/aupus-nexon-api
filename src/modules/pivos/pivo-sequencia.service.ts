import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser, ClienteInfo } from '@/core';
import { novoId26 } from '../../core/common/cliente-info';
import { capacidades, MSG_SOMENTE_LEITURA, papelCanonico } from '../../core/modules/auth/papeis';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import { FUSO_OPERACAO, JanelaComAtivo, janelaValida, momentoEmSaoPaulo } from '../../shared/util/janela-horario';
import { anguloDoEncoder, brutoDoEncoder, parametrosEncoder } from './pivo-posicao.util';
import { PivoTonService, TXT_FALHA } from './pivo-ton.service';
import { calibracaoVigente } from './pivo-calibracao.repo';
import { dentroDaPonta, duracaoParadaMs, fmtPercentual, Irrigacao, leituraMaisAntiga, mudancasConfig, normalizarIrrigacao, normalizarPercentual, OrigemSequencia, percentualDaLamina, resumoIrrigacao } from './pivo-automacao.util';

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
 * Bombeamento = ponto Ligar do pivô (o painel liga a bomba e fecha a solenoide) + status
 * Ligado, em BO/BI de qualquer TON (Topologia IoT → Configurar I/O). O Desligar do pivô
 * para tudo, bomba junto. Sistema conjugado = usar o Ligar de outro pivô
 * (pivo_config.bombeamento.bomba_de). Sem pontos, vale a configuração antiga
 * (pivo_config.bombeamento com ton_id/BOs).
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
  /** pontos: TON do retorno Ligado (pode ser outra TON); legado: tudo em ton_id */
  bi_ton_id?: string | null;
  bi_inv?: boolean;
  origem?: 'pontos' | 'legado';
  /** pivô dono dos pontos da bomba (o próprio ou o do sistema conjugado) */
  dono_id?: string;
}
/**
 * comandos_mantidos: as BOs do pivô ficam em ALTO enquanto a função está ligada (painel sem
 * selo, ex.: TON no lugar do CLP) — Ligar/Girar/Canhão = `rN on`, desligar = `rN off`.
 * Padrão (false): pulsos nos botões do painel, que faz o selo.
 */
export interface SequenciaCfg { pressurizacao_s: number; confirma_giro_s: number; confirma_bomba_s: number; comandos_mantidos: boolean }
export interface AcionarOpts {
  irrigacao?: unknown;
  origem?: OrigemSequencia;
  /** autor da trilha quando quem age é o servidor (dono da programação, quem ligou antes da ponta) */
  responsavelId?: string | null;
  /** texto extra na trilha ("parada por 2 voltas", "início da ponta 18:00") */
  motivo?: string;
  /** desligar da ponta: o que retomar ao fim dela */
  retomar?: { irrigacao: Irrigacao | null; acao: AcaoPivo; restante_ms: number | null } | null;
  /**
   * NEXON-98 — "Salvar e enviar" com o pivô LIGADO: desliga (pivô, canhão e bomba), confirma a
   * parada e liga de novo com a `irrigacao` nova, tudo numa sequência só. Só com girar_*.
   */
  reiniciar?: boolean;
  /**
   * Reinício sem mexer na Parada: herda a parada em curso. Por tempo (programação) e por voltas
   * seguem com o que FALTA (o `parar_em` atual, na velocidade nova); por ângulo recalcula do
   * ângulo atual. Sem isto, a parada enviada vale do zero.
   */
  manterParada?: boolean;
}

/** Tempo que a bomba tem de aparecer desligada para o NexON dar por encerrada uma irrigação parada. */
const BOMBA_DESLIGADA_SUSTENTADA_MS = 60_000;
/** Descanso entre a parada confirmada e a nova partida no reinício (bomba e painel assentam). */
const PAUSA_REINICIO_S = 10;

interface Passo { t: string; etapa: string; msg: string; ok: boolean | null }
type Autor = ScopedUser & { nome?: string };

const SEQ_PADRAO: SequenciaCfg = { pressurizacao_s: 120, confirma_giro_s: 30, confirma_bomba_s: 30, comandos_mantidos: false };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

type PapelComando = 'ligar' | 'valvula' | 'canhao' | 'percentimetro' | 'direita' | 'esquerda' | 'desligar';
type PapelStatus = 'ligado' | 'canhao' | 'permissivo' | 'pressao' | 'direita' | 'esquerda' | 'desligado' | 'erro';
type MapaBi = { ton_id: string; bi: number; inv: boolean };
/** Resultado de comandar o canhão (aplicarCanhao). */
type ResCanhao = 'ok' | 'ja' | 'sem_ponto' | 'sem_status' | 'sem_leitura' | 'nao_confirmou' | 'enviado';

/**
 * Pontos do pivô por papel, achados pelo nome (Girar_direita, Girando_esquerda, Desligado, Erro…).
 * A ordem dos testes está em pontos(); "Desligar"/"Desligado" nunca casam com Ligar/Ligado.
 */
const PAPEIS_COMANDO: Record<PapelComando, RegExp> = {
  // Ligar: o painel liga a bomba e fecha a solenoide (só na partida com água)
  // "Bombeamento" (padrão) não contém "bomba" — casa por "bomb".
  ligar: /^(?!.*deslig).*(ligar|bomb)/,
  // Válvula ON/OFF do pivô (BO02 do padrão): saída mantida, abre com a bomba e fecha depois dela
  valvula: /valvul|solenoid/,
  // Canhão final: botão do painel que ALTERNA (pulso); o estado vem do Canhao_ligado
  canhao: /canha/,
  // Percentímetro = BO do motor de movimento (ciclo local na TON — docs/IOT-PIVO-PERCENTIMETRO-LAMINA.md)
  percentimetro: /percent/,
  direita: /direit|horario(?!.*anti)/,
  esquerda: /esquerd|anti.?horario/,
  desligar: /deslig|parar|stop/,
};
const PAPEIS_STATUS: Record<PapelStatus, RegExp> = {
  // Ligado: retorno do Ligar (bomba ligada)
  ligado: /^(?!.*(deslig|canha)).*(ligad|bomba)/,
  // Canhao_ligado: estado do canhão final
  canhao: /canha/,
  // Permissivo para ligar: o painel junta as condições (bomba, tensão, pressão) numa BI
  permissivo: /permiss/,
  // Pressostato: água chegou ao pivô (partida espera ele antes de girar)
  pressao: /press/,
  direita: /direit/,
  esquerda: /esquerd/,
  desligado: /deslig|parad/,
  erro: /erro|falha/,
};

/**
 * Chave seletora do painel em modo TON (NEXON-103): ponto de status "Modo_TON" ligado a uma BI.
 * No modo CLP a TON não comanda o pivô nem está ligada ao encoder. Fica FORA dos status do pivô
 * (não entra no `lido_em` nem na trava de comando): só a calibração do ângulo depende dele.
 */
const PAPEL_MODO_TON = /modo.?ton|chave.?(seletora|ton)|seletora/;

const MSG_CANHAO: Record<ResCanhao, (ligar: boolean, s: number) => string> = {
  ok: (l) => `Canhão final ${l ? 'ligado' : 'desligado'} (confirmado)`,
  ja: (l) => `Canhão final já estava ${l ? 'ligado' : 'desligado'}`,
  sem_ponto: () => 'Canhão: o pivô não tem o ponto Canhao ligado a uma BO',
  sem_status: () => 'Canhão: sem o status Canhao_ligado o NexON não comanda (o botão alterna)',
  sem_leitura: () => 'Canhão: sem leitura do Canhao_ligado — não comandado',
  nao_confirmou: (l, s) => `Canhão não confirmou ${l ? 'ligado' : 'desligado'} em ${s}s`,
  enviado: (l) => `Canhão final ${l ? 'ligado' : 'desligado'} (saída mantida, sem status para confirmar)`,
};

/** Posição do pivô para a tela e para a parada por ângulo (ver posicao()). */
export interface PosicaoPivo {
  fonte: 'encoder' | 'telemetria';
  angulo: number | null;
  /** Ângulo antes da correção do zero (base do "Zerar aqui"). Só com encoder. */
  angulo_sem_zero: number | null;
  /** Contagem bruta do encoder. */
  bruto: number | null;
  lido_em: Date | null;
  motivo: string | null;
  encoder: { equipamento_id: string; resolucao: number | null; invertido: boolean; zero: number } | null;
  /**
   * NEXON-103 — pivô com encoder e nenhuma calibração ativa: `angulo` fica null e a tela
   * mostra só o valor bruto, com aviso. false também para pivô sem encoder.
   */
  sem_calibracao: boolean;
  /** Calibração vigente (calibracao_angulo), para a tela dizer de quando é. */
  calibracao: { id: string; az_cal: number; bruto_cal: number; sentido: 1 | -1; criado_em: Date } | null;
}

@Injectable()
export class PivoSequenciaService implements OnModuleInit {
  private readonly logger = new Logger(PivoSequenciaService.name);
  /** sequências em execução neste processo: pivoId → flag de cancelamento */
  // finalizando = sequência já concluída, só esperando o ack de limpeza (perc off)
  private readonly rodando = new Map<string, { seqId: string; cancelar: boolean; finalizando?: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly cmd: EquipamentosCmdService,
    // Sequência na TON (docs/IOT-PIVO-TON-LOCAL.md, Fase 3). Opcional: sem ela tudo segue no servidor.
    @Optional() private readonly ton?: PivoTonService,
  ) {
    this.cmd.observarPontoExterno?.((fase, eq, ponto, user, cliente) => this.pontoExterno(fase, eq, ponto, user, cliente));
    if (this.ton) this.ton.aoPararSozinho = (tonId, motivo, falha) => { void this.paradaDaTon(tonId, motivo, falha); };
  }

  /** A TON parou o pivô sozinha (parada programada, segurança, falha, reinício): fica na trilha do pivô. */
  private async paradaDaTon(tonId: string, motivo: string, falha: boolean) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT TRIM(p.equipamento_id) AS id FROM ton_bo b
      JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
      JOIN equipamentos e ON e.id = p.equipamento_id
      LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
      WHERE b.ton_id = ${tonId}::bpchar AND b.deleted_at IS NULL AND UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%'`.catch(() => []);
    for (const r of rows) {
      const txt = `Pivô parou pela TON: ${TXT_FALHA[motivo] ?? motivo ?? 'parado'}`;
      await this.trilha(r.id, txt, null, 'parada', falha ? 'ALTA' : 'INFO').catch(() => undefined);
      // Encerra a irrigação em curso na hora (a ficha sai de "Irrigando" sem esperar as BIs de giro):
      // um Desligar concluído, de origem "parada", com o motivo da TON.
      if (this.rodando.has(r.id)) continue;
      const ativa = await this.irrigacaoAtiva(r.id).catch(() => null);
      if (!ativa) continue;
      const passos = [{ t: new Date().toISOString(), etapa: 'ton', msg: txt, ok: !falha }];
      await this.prisma.$executeRaw`
        INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, origem, passos, erro, finished_at)
        VALUES (${novoId26()}, ${r.id}::bpchar, 'desligar', 'concluida', 'parada', ${JSON.stringify(passos)}::jsonb,
          ${falha ? txt : null}, now())`.catch((e) => this.logger.warn(`[pivo-ton] encerrar irrigação de ${r.id}: ${e?.message ?? e}`));
    }
  }

  /** Estado da sequência na TON do pivô (status/ack mais recente), para a ficha. */
  private async tonLocal(pts: { cmd: Partial<Record<PapelComando, string>> }) {
    if (!this.ton) return null;
    const m = await this.boDoPonto(pts.cmd.direita ?? pts.cmd.esquerda);
    return m ? this.ton.statusDaTon(m.ton_id) : null;
  }

  /** Pivôs que receberam Desligar direto no ponto com sequência em andamento (ver pontoExterno). */
  private readonly desligarExterno = new Set<string>();

  /**
   * Desligar mandado DIRETO no ponto do pivô (apps, rota do equipamentos-cmd) com uma sequência
   * em andamento — partida ou reinício. Sem isto a sequência não ficava sabendo e seguia: o
   * operador desligava e o pivô ligava (ou religava) sozinho logo depois.
   *  - antes do pulso: marca a sequência para interromper;
   *  - depois do pulso: roda o Desligar inteiro (canhão, bomba, percentímetro), que a sequência
   *    interrompida não completa.
   */
  async pontoExterno(fase: 'antes' | 'depois', equipamentoId: string, pontoId: string, user?: Autor, cliente?: ClienteInfo) {
    const id = String(equipamentoId).trim();
    if (fase === 'antes') {
      const ctl = this.rodando.get(id);
      if (!ctl || ctl.finalizando) return;
      const pts = await this.pontos(id);
      const ponto = String(pontoId).trim();
      // Ligar / girar direto no ponto no meio da sequência (ex.: o pivô parado na pausa do
      // reinício e a lista do app oferecendo "Ligar"): recusa — cruzaria com a partida do servidor.
      if (ponto === pts.cmd.direita || ponto === pts.cmd.esquerda || ponto === pts.cmd.ligar) {
        throw new ConflictException('Sequência do pivô em andamento — aguarde terminar ou use Desligar para interromper.');
      }
      if (pts.cmd.desligar !== ponto) return;
      ctl.cancelar = true;
      this.desligarExterno.add(id);
      return;
    }
    if (!this.desligarExterno.delete(id)) return;
    await this.acionar(id, 'desligar', user, cliente, { motivo: 'Desligar direto no ponto interrompeu a sequência em andamento' })
      // já parado e sem bomba ligada: nada a completar
      .catch((e) => this.logger.warn(`[pivo-seq] ${id} desligar após comando direto no ponto: ${e?.response?.message || e?.message}`));
  }

  async onModuleInit() {
    // processo reiniciou no meio de uma sequência: não há como retomar com segurança
    await this.prisma.$executeRaw`
      UPDATE pivo_sequencias SET status = 'interrompida', finished_at = now(),
        erro = COALESCE(erro, 'Servidor reiniciado durante a sequência')
      WHERE status = 'executando'`.catch(() => undefined);
  }

  // ------------------------------------------------------------------ config
  /**
   * Bomba do pivô: os pontos do próprio pivô, ou os do pivô do sistema conjugado
   * (bomba_de). Sem pontos e sem conjugado, a configuração antiga (ton_id/BOs) — legado.
   */
  async lerConfig(pivoId: string): Promise<{ bombeamento: Bombeamento | null; bomba_de: string | null; sequencia: SequenciaCfg }> {
    const rows = await this.prisma.$queryRaw<Array<{ bombeamento: any; sequencia: any }>>`
      SELECT bombeamento, sequencia FROM pivo_config WHERE equipamento_id = ${pivoId}::bpchar LIMIT 1`;
    const b = rows[0]?.bombeamento;
    const s = rows[0]?.sequencia ?? {};
    const bombaDe = typeof b?.bomba_de === 'string' && b.bomba_de.trim() ? b.bomba_de.trim() : null;
    let bomba = await this.bombaDosPontos(bombaDe ?? pivoId);
    if (!bomba && !bombaDe && b?.ton_id && b?.bo_liga) bomba = { ...(b as Bombeamento), origem: 'legado', dono_id: pivoId };
    const confirmaBomba = Number(s.confirma_bomba_s) || Number(b?.confirma_s) || SEQ_PADRAO.confirma_bomba_s;
    if (bomba) bomba.confirma_s = confirmaBomba;
    return {
      bombeamento: bomba,
      bomba_de: bombaDe,
      sequencia: {
        pressurizacao_s: Number.isFinite(Number(s.pressurizacao_s)) ? Number(s.pressurizacao_s) : SEQ_PADRAO.pressurizacao_s,
        confirma_giro_s: Number(s.confirma_giro_s) || SEQ_PADRAO.confirma_giro_s,
        confirma_bomba_s: confirmaBomba,
        // ON/OFF na BO do Bombeamento (pulso 0 no Configurar I/O) também vale como saídas mantidas.
        comandos_mantidos: s.comandos_mantidos === true || (bomba?.origem === 'pontos' && bomba.modo === 'mantido'),
      },
    };
  }

  /** Saídas mantidas (sequencia.comandos_mantidos) do pivô — lido direto, sem montar a config toda. */
  private async mantido(pivoId: string): Promise<boolean> {
    const r = await this.prisma.$queryRaw<Array<{ m: boolean | null }>>`
      SELECT (sequencia->>'comandos_mantidos')::boolean AS m FROM pivo_config WHERE equipamento_id = ${pivoId}::bpchar LIMIT 1`.catch(() => []);
    if (r[0]?.m === true) return true;
    // BO do Bombeamento como saída ON/OFF (pulso_ms = 0 no Configurar I/O da TON) = alto permanente.
    const liga = await this.boDoPonto((await this.pontos(pivoId)).cmd.ligar);
    return liga?.pulso_ms === 0;
  }

  /**
   * Saída mantida de um ponto de comando: `rN on` (ligar) ou `rN off`, com as restrições e
   * a trilha do acionar (acionarBoDireto). false = ponto sem BO vinculada.
   */
  private async saidaMantida(id: string, pid: string | undefined, ligar: boolean, rotulo: string, user?: Autor, cliente?: ClienteInfo): Promise<boolean> {
    const m = await this.boDoPonto(pid);
    if (!m) return false;
    await this.cmd.acionarBoDireto({ equipamentoId: id, tonId: m.ton_id, bo: m.bo, modo: ligar ? 'liga' : 'desliga', rotulo }, user, cliente);
    return true;
  }

  /**
   * Bomba pelos pontos do pivô: Ligar (pulso no botão do painel) + Ligado (retorno).
   * Desligar = o Desligar do pivô dono (desligarBomba). null sem Ligar ligado a uma BO.
   */
  private async bombaDosPontos(pivoId: string): Promise<Bombeamento | null> {
    const pts = await this.pontos(pivoId);
    const liga = await this.boDoPonto(pts.cmd.ligar);
    if (!liga) return null;
    const bi = pts.st.ligado;
    return {
      ativo: true, origem: 'pontos', dono_id: pivoId, modo: (await this.mantido(pivoId)) ? 'mantido' : 'pulso',
      ton_id: liga.ton_id, bo_liga: liga.bo, pulso_ms: liga.pulso_ms, bo_desliga: null,
      bi_confirma: bi?.bi ?? null, bi_ton_id: bi?.ton_id ?? null, bi_inv: !!bi?.inv,
    };
  }

  /** BO vinculada a um ponto de comando (Topologia IoT → Configurar I/O), ou null. */
  private async boDoPonto(pid: string | undefined): Promise<{ ton_id: string; bo: number; pulso_ms: number } | null> {
    if (!pid) return null;
    const rows = await this.prisma.$queryRaw<Array<{ bo: number; ton_id: string; pulso_ms: number }>>`
      SELECT b.bo_numero AS bo, TRIM(b.ton_id) AS ton_id, b.pulso_ms FROM ton_bo b
      WHERE b.equipamento_ponto_id = ${pid}::bpchar AND b.deleted_at IS NULL AND b.ativo LIMIT 1`;
    return rows[0] ?? null;
  }

  /** Bomba ligada pela BI de confirmação (respeita "invertido"); null = sem BI ou sem leitura. */
  private async bombaLigada(b: Bombeamento): Promise<0 | 1 | null> {
    if (!b.bi_confirma) return null;
    const v = (await this.cmd.lerEntradaTon(b.bi_ton_id ?? b.ton_id, b.bi_confirma)).valor;
    return v === null ? null : ((b.bi_inv ? 1 - v : v) as 0 | 1);
  }

  /**
   * Grava o sistema conjugado (bomba_de = pivô dono da bomba) e os tempos da sequência.
   * A bomba em si não se configura aqui: são os pontos do pivô na Topologia IoT.
   * O formato antigo (ton_id/BOs) ainda é aceito — bundle antigo em cache.
   */
  async salvarConfig(pivoId: string, body: { bombeamento?: (Partial<Bombeamento> & { bomba_de?: string | null }) | null; sequencia?: Partial<SequenciaCfg> }, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    // Bombeamento e tempos da sequência = configuração técnica (PER-33a): Admin e
    // analistas (inclusive o de operação, que não tem equipamentos.manage).
    if (user && !capacidades(papelCanonico(user.role)).configTecnica) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
    let bomb: Record<string, unknown> | null = null;
    const nb = body.bombeamento;
    if (nb && 'bomba_de' in nb) {
      const de = nb.bomba_de ? String(nb.bomba_de).trim() : null;
      if (de) {
        if (de === id) throw new BadRequestException('Sistema conjugado: escolha outro pivô.');
        await this.assertPivo(de, user);
        const mesmaPlanta = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
          SELECT (SELECT u.planta_id FROM equipamentos e JOIN unidades u ON u.id = e.unidade_id WHERE e.id = ${id}::bpchar)
               = (SELECT u.planta_id FROM equipamentos e JOIN unidades u ON u.id = e.unidade_id WHERE e.id = ${de}::bpchar) AS ok`;
        if (!mesmaPlanta[0]?.ok) throw new BadRequestException('Sistema conjugado: o outro pivô tem de ser da mesma planta.');
        if (!(await this.bombaDosPontos(de))) throw new BadRequestException('O pivô escolhido não tem o Ligar ligado a uma BO na Topologia IoT.');
        bomb = { bomba_de: de };
      }
    } else if (nb && nb.ativo !== false) {
      const b = nb;
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
      confirma_bomba_s: Math.max(5, Math.min(300, Number(body.sequencia?.confirma_bomba_s ?? atual.sequencia.confirma_bomba_s))),
      comandos_mantidos: typeof body.sequencia?.comandos_mantidos === 'boolean' ? body.sequencia.comandos_mantidos : atual.sequencia.comandos_mantidos,
    };
    // Trocar o modo com o pivô ligado deixaria saída presa (mantido → pulso) ou sem selo (pulso → mantido).
    if (seq.comandos_mantidos !== atual.sequencia.comandos_mantidos && (this.rodando.has(id) || (await this.irrigacaoAtiva(id)))) {
      throw new ConflictException('Desligue o pivô antes de trocar o modo das saídas (pulso ↔ mantidas).');
    }
    const cru = await this.prisma.$queryRaw<Array<{ bombeamento: any }>>`
      SELECT bombeamento FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`;
    const antes = cru[0]?.bombeamento ?? null;
    const depois = nb === undefined ? antes : bomb;
    await this.prisma.$executeRaw`
      INSERT INTO pivo_config (equipamento_id, bombeamento, sequencia, updated_at, updated_by)
      VALUES (${id}::bpchar, ${depois ? JSON.stringify(depois) : null}::jsonb, ${JSON.stringify(seq)}::jsonb, now(), ${user?.id?.trim() || null})
      ON CONFLICT (equipamento_id) DO UPDATE SET bombeamento = EXCLUDED.bombeamento, sequencia = EXCLUDED.sequencia,
        updated_at = now(), updated_by = EXCLUDED.updated_by`;
    const mudou = mudancasConfig({ ...(antes ?? {}), ...atual.sequencia }, { ...(depois ?? {}), ...seq });
    if (mudou.length) await this.trilha(id, `Bombeamento alterado: ${mudou.join('; ')}`, user?.id?.trim() || null, 'manual');
    return this.estado(id, user);
  }

  /** Pivôs da mesma planta com a bomba ligada na Topologia (para o sistema conjugado). */
  async opcoes(pivoId: string, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    let pivos = await this.pivosDaPlanta(id);
    // Operador: só pivôs liberados a ele (PER-23), não os da planta inteira.
    const eqs = user ? await this.scope.getEquipamentosScope(user) : null;
    if (eqs) {
      const lib = new Set(eqs);
      pivos = pivos.filter((p) => lib.has(p.id));
    }
    const bombas: Array<{ pivo_id: string; nome: string }> = [];
    for (const p of pivos) if (await this.bombaDosPontos(p.id)) bombas.push({ pivo_id: p.id, nome: p.nome });
    return { bombas };
  }

  /** Outros pivôs da mesma planta do pivô. */
  private async pivosDaPlanta(id: string): Promise<Array<{ id: string; nome: string }>> {
    return this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome
      FROM equipamentos e
      JOIN unidades u ON u.id = e.unidade_id
      LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
      WHERE e.deleted_at IS NULL AND e.id <> ${id}::bpchar
        AND UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%'
        AND u.planta_id = (SELECT u2.planta_id FROM equipamentos p2 JOIN unidades u2 ON u2.id = p2.unidade_id WHERE p2.id = ${id}::bpchar)
      ORDER BY e.nome`;
  }

  /** "TON4v2 · 46:A8" — nome + fim do MAC (há TONs com o mesmo nome). */
  private async rotuloTon(tonId: string | null | undefined): Promise<string | null> {
    if (!tonId) return null;
    const t = await this.prisma.equipamentos.findFirst({ where: { id: tonId }, select: { nome: true, mac_address: true, deleted_at: true } });
    if (!t) return 'TON removida';
    const mac = t.mac_address?.trim();
    return `${t.nome?.trim() ?? 'TON'}${mac ? ` · ${mac.slice(-5).toUpperCase()}` : ''}${t.deleted_at ? ' (removida)' : ''}`;
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
      const lida = b.bi_confirma ? await this.cmd.lerEntradaTon(b.bi_ton_id ?? b.ton_id, b.bi_confirma) : null;
      const comp = await this.companheiros(id, b);
      const tonLiga = await this.rotuloTon(b.ton_id);
      bomba = {
        ...b,
        ton_nome: ton?.nome?.trim() ?? null,
        ton_removida: !ton || !!ton.deleted_at,
        ligada: lida?.valor == null ? null : b.bi_inv ? 1 - lida.valor : lida.valor,
        ligada_em: lida?.updated_at ?? null,
        compartilhada_com: comp.map((c) => c.nome),
        dono_nome: b.dono_id && b.dono_id !== id ? (await this.prisma.equipamentos.findFirst({ where: { id: b.dono_id }, select: { nome: true } }))?.nome?.trim() ?? null : null,
        // Onde está cada sinal (TON · fim do MAC · saída), para a Configuração mostrar
        saidas: {
          ligar: { ton: tonLiga, saida: `BO${b.bo_liga}` },
          // pontos: desliga pelo Desligar do pivô (null); legado: BO de desligar própria
          desligar: b.modo === 'pulso' && b.bo_desliga ? { ton: tonLiga, saida: `BO${b.bo_desliga}` } : null,
          confirma: b.bi_confirma ? { ton: await this.rotuloTon(b.bi_ton_id ?? b.ton_id), saida: `BI${b.bi_confirma}` } : null,
        },
      };
    }
    const bombaDeNome = cfg.bomba_de
      ? (await this.prisma.equipamentos.findFirst({ where: { id: cfg.bomba_de }, select: { nome: true } }))?.nome?.trim() ?? null
      : null;
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
        AND NOT (status = 'cancelada' AND erro LIKE 'Reinício%')
      ORDER BY created_at DESC LIMIT 1`;
    // Reinício que não executou (linha 'cancelada', fora de `sequencia`): a ficha precisa avisar
    // que as novas opções NÃO valeram. Só o mais recente, das últimas 6 h, e posterior à sequência atual.
    const reinicio = await this.prisma.$queryRaw<any[]>`
      SELECT erro, created_at, finished_at FROM pivo_sequencias
      WHERE equipamento_id = ${id}::bpchar AND status = 'cancelada' AND erro LIKE 'Reinício%'
        AND finished_at > now() - interval '6 hours'
      ORDER BY created_at DESC LIMIT 1`;
    const desligarNaoConcluiu = await this.prisma.$queryRaw<any[]>`
      SELECT erro, created_at, finished_at FROM pivo_sequencias
      WHERE equipamento_id = ${id}::bpchar AND status = 'cancelada' AND erro LIKE 'Desligar não concluiu%'
        AND finished_at > now() - interval '6 hours'
      ORDER BY created_at DESC LIMIT 1`;
    const desligarFalhou = desligarNaoConcluiu[0] && (!seq[0] || new Date(desligarNaoConcluiu[0].created_at).getTime() > new Date(seq[0].created_at).getTime())
      ? { erro: String(desligarNaoConcluiu[0].erro), em: desligarNaoConcluiu[0].finished_at } : null;
    const reinicioFalhou = reinicio[0] && (!seq[0] || new Date(reinicio[0].created_at).getTime() > new Date(seq[0].created_at).getTime())
      ? { erro: String(reinicio[0].erro), em: reinicio[0].finished_at } : null;
    // Pausada pela ponta: última sequência é o desligar da ponta com algo a retomar.
    const pausa = seq[0]?.acao === 'desligar' && seq[0]?.origem === 'ponta'
      ? await this.lerPonta(id) : null;
    const ativa = await this.irrigacaoAtiva(id);
    return {
      pivo: {
        // Saídas mantidas: desligar = baixar as BOs de giro (não precisa do ponto Desligar)
        comandos: { direita: !!pts.cmd.direita, esquerda: !!pts.cmd.esquerda, desligar: !!pts.cmd.desligar || (cfg.sequencia.comandos_mantidos && !!(pts.cmd.direita || pts.cmd.esquerda)), percentimetro: !!pts.cmd.percentimetro,
          // Dá para ligar PARADO (água sem girar): pelo percentímetro em 0 % ou, sem o ponto, só com a bomba (NEXON-98)
          parado: !!(await this.boDoPonto(pts.cmd.percentimetro)) || (!!cfg.bombeamento && !!cfg.bombeamento.bi_confirma) },
        comandos_mantidos: cfg.sequencia.comandos_mantidos,
        // Canhão: comandável só com o ponto Canhao (BO) e o status Canhao_ligado (BI)
        canhao: { comando: !!pts.cmd.canhao, tem_status: !!pts.st.canhao, ligado: await this.lerStatus(pts.st.canhao) },
        permissivo: await this.lerStatus(pts.st.permissivo),
        status: st,
        lido_em: await this.lidoEmPivo(pts),
        // Chave seletora em modo TON (NEXON-103): null = sem leitura; tem_modo_ton false = pivô sem a chave
        tem_modo_ton: !!pts.modoTon,
        modo_ton: await this.lerStatus(pts.modoTon ?? undefined),
        // Sequência na TON (Fase 3): estado/passo/falha/ângulo como a TON reportou (null = TON sem sequência local)
        ton_local: await this.tonLocal(pts).catch(() => null),
      },
      posicao: await this.posicao(id),
      bombeamento: bomba,
      bomba_de: cfg.bomba_de ? { id: cfg.bomba_de, nome: bombaDeNome } : null,
      sequencia_cfg: cfg.sequencia,
      sequencia: seq[0] ?? null,
      reinicio_falhou: reinicioFalhou,
      // Desligar de irrigação parada que não desligou a bomba (a irrigação segue em curso)
      desligar_falhou: desligarFalhou,
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
    const reiniciar = opts.reiniciar === true;
    if (reiniciar && acao === 'desligar') throw new BadRequestException('Reiniciar vale só para girar_direita | girar_esquerda.');
    const id = await this.assertPivo(pivoId, user);
    const eq = await this.prisma.equipamentos.findFirst({ where: { id }, select: { nome: true, automacao: true } });
    if (!eq?.automacao) throw new BadRequestException(`"${eq?.nome?.trim()}" não tem automação habilitada.`);
    const pts = await this.pontos(id);
    const papel = acao === 'girar_direita' ? 'direita' : acao === 'girar_esquerda' ? 'esquerda' : 'desligar';
    const cfg = await this.lerConfig(id);
    const desligaMantido = acao === 'desligar' && cfg.sequencia.comandos_mantidos && !!(pts.cmd.direita || pts.cmd.esquerda);
    if (!pts.cmd[papel] && !(acao === 'desligar' && cfg.bombeamento) && !desligaMantido) {
      throw new BadRequestException(`O pivô não tem o comando "${papel}" cadastrado (ponto de comando ligado a uma BO).`);
    }
    const autorId = user?.id?.trim() || opts.responsavelId?.trim() || null;
    let irrigacao = acao === 'desligar' ? null : normalizarIrrigacao(opts.irrigacao);
    if (irrigacao) irrigacao.config.direcao = acao === 'girar_direita' ? 'Avanço' : 'Reverso';
    let antesDoReinicio: Irrigacao | null = null;
    let restanteParadaMs: number | null | undefined;   // undefined = calcula do zero na partida
    if (reiniciar) {
      if (!irrigacao) throw new BadRequestException('Reiniciar precisa das novas opções da irrigação.');
      // Reinício é sempre agora: início futuro viraria agendamento com o pivô ainda girando.
      if (irrigacao.inicio && new Date(irrigacao.inicio).getTime() - Date.now() > 60000) {
        throw new BadRequestException('Reiniciar é sempre agora: não aceita início agendado.');
      }
      irrigacao = { ...irrigacao, inicio: null };
      // Sem um jeito de PARAR o pivô (ponto Desligar ou saídas mantidas) não há reinício: a
      // sequência desligaria a bomba e mandaria girar com o pivô ainda girando.
      if (!pts.cmd.desligar && !(cfg.sequencia.comandos_mantidos && (pts.cmd.direita || pts.cmd.esquerda))) {
        throw new BadRequestException('Este pivô não tem o comando Desligar cadastrado (ponto ligado a uma BO): desligue no painel e ligue de novo com as novas opções.');
      }
    }
    // Lâmina pedida → percentímetro (o servidor é quem calcula, com a lâmina a 100 % do cadastro).
    if (irrigacao?.config.lamina && !irrigacao.config.semAgua) {
      const { lamina100 } = await this.parametrosPercentimetro(id);
      if (!lamina100) throw new BadRequestException('Cadastre a "Lâmina a 100%" na Configuração do pivô para irrigar por lâmina (ou informe o percentual).');
      const pct = percentualDaLamina(irrigacao.config.lamina, lamina100);
      if (pct === null) throw new BadRequestException(`Lâmina mínima deste pivô: ${String(lamina100).replace('.', ',')} mm (100 %).`);
      irrigacao.config.percentual = pct;
    }

    // "Parado" (0 %, com água): liga a água e o pivô não gira — irriga no lugar. Não percorre
    // ângulo nem volta. Com o ponto Percentímetro, vai pelo caminho normal (gira com 0 %).
    // SEM o ponto (NEXON-98), o servidor liga só a bomba e não manda girar (`semGiro`): precisa
    // de uma bomba configurada, senão não há o que ligar.
    if (irrigacao && !irrigacao.config.semAgua && !(irrigacao.config.percentual > 0)) {
      if (irrigacao.parada.tipo === 'porAngulo' || irrigacao.parada.tipo === 'porVoltas') {
        throw new BadRequestException('Parado não percorre ângulo nem volta: use parada por tempo ou sem parada.');
      }
      // "Tem percentímetro" = o ponto ligado a uma BO de verdade (o ponto sozinho não segura o pivô).
      if (!(await this.boDoPonto(pts.cmd.percentimetro))) {
        if (!cfg.bombeamento) throw new BadRequestException('Este pivô não tem bomba configurada no NexON: não há o que ligar com o pivô parado.');
        // Sem girar, só a bomba diz se a irrigação segue ligada: sem a confirmação dela (BI) o
        // NexON não saberia quando acabou.
        if (!cfg.bombeamento.bi_confirma) throw new BadRequestException('A bomba deste pivô não tem confirmação de ligada (BI): não dá para irrigar parado pelo NexON.');
        irrigacao = { ...irrigacao, config: { ...irrigacao.config, semGiro: true, canhao: false, faixasCanhao: [] } };
      }
    }

    if (acao === 'desligar') {
      // TRAVA: não desliga o que já está desligado.
      const motivoNao = await this.travaDesligar(id, pts, cfg);
      if (motivoNao) throw new ConflictException(motivoNao);
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
      // Sequência anterior já concluída, só limpando o percentímetro: espera o ack ANTES da
      // trava — assim ela confere o pivô como ficou (um reinício logo após o Desligar não religa).
      for (let i = 0; i < 60 && this.rodando.get(id)?.finalizando; i++) await this.sleep(250);
      if (this.rodando.has(id)) throw new ConflictException('Já existe uma sequência em andamento neste pivô. Use Desligar para interromper.');
      // TRAVA: só liga (ou inverte o sentido) com o pivô PARADO. Vale na hora de ligar —
      // o agendamento acima é conferido de novo quando disparar.
      // Reinício é o contrário: só com o pivô LIGADO (parado, é um Ligar comum).
      const motivoNao = reiniciar ? await this.travaReiniciar(id, pts) : await this.travaLigar(id, pts);
      if (motivoNao) throw new ConflictException(motivoNao);
      if (reiniciar && irrigacao) {
        const ativa = await this.irrigacaoAtiva(id);
        antesDoReinicio = ativa?.irrigacao ?? null;
        const pa = antesDoReinicio?.parada;
        // Parada não alterada: o reinício não pode apagar a parada automática em curso.
        if (opts.manterParada && pa && pa.tipo !== 'semParar') {
          irrigacao = { ...irrigacao, parada: pa, programacao: antesDoReinicio?.programacao ?? irrigacao.programacao ?? null };
          const resta = ativa?.parar_em ? new Date(ativa.parar_em).getTime() - Date.now() : null;
          if (pa.tipo === 'porTempo') {
            // o que falta do tempo; já vencido, para em 1 min (o tick ia desligar agora)
            if (resta != null) restanteParadaMs = Math.max(60000, resta);
          } else if (pa.tipo === 'porVoltas' && resta != null) {
            // o que falta percorrer, na velocidade nova (seco anda a 100 %; 0 % não chega);
            // já vencido, para em 1 min, como por tempo (nunca recomeça as voltas do zero)
            const vAntes = antesDoReinicio!.config.semAgua ? 100 : antesDoReinicio!.config.percentual;
            const vNovo = irrigacao.config.semAgua ? 100 : irrigacao.config.percentual;
            if (resta <= 0) restanteParadaMs = 60000;
            else if (vAntes > 0) restanteParadaMs = vNovo > 0 ? Math.max(60000, Math.round(resta * (vAntes / vNovo))) : null;
          }
          // por ângulo: a partida recalcula do ângulo atual, no sentido novo
          // Parado não alcança ângulo nem volta: a parada herdada cai (fica sem parada).
          if (!irrigacao.config.semAgua && !(irrigacao.config.percentual > 0) && (pa.tipo === 'porAngulo' || pa.tipo === 'porVoltas')) {
            irrigacao = { ...irrigacao, parada: { tipo: 'semParar' } };
            restanteParadaMs = undefined;
          }
        }
      }
    }

    // O que este Desligar (ou reinício) vai parar é uma irrigação PARADA (só a bomba)? As regras
    // novas de parada — Desligar do pivô como melhor esforço, bomba presa não conclui, nova
    // tentativa — valem SÓ para ela. Pivô girando para exatamente como sempre parou.
    // (Lido AQUI, antes da conferência da trava em memória: entre ela e a reserva não pode haver await.)
    const paraSemGiro = (acao === 'desligar' || reiniciar)
      ? (await this.irrigacaoAtiva(id).catch(() => null))?.irrigacao?.config?.semGiro === true
      : false;

    // Sequência anterior já concluída, só limpando o percentímetro: espera o ack em vez de recusar.
    for (let i = 0; i < 60 && this.rodando.get(id)?.finalizando; i++) await this.sleep(250);
    const atual = this.rodando.get(id);
    if (atual) {
      if (acao !== 'desligar') throw new ConflictException('Já existe uma sequência em andamento neste pivô. Use Desligar para interromper.');
      atual.cancelar = true;   // Desligar sempre pode: interrompe a partida em curso
      for (let i = 0; i < 40 && this.rodando.has(id); i++) await this.sleep(250);
    }

    this.bombaZeroDesde.delete(id);   // sequência nova: a contagem de "bomba desligada" recomeça
    // Reserva a trava ANTES de gravar (sem await entre conferir e reservar): dois pedidos
    // juntos (duplo clique, dois operadores) não rodam duas sequências no mesmo pivô.
    const seqId = novoId26();
    const ctl = { seqId, cancelar: false };
    this.rodando.set(id, ctl);
    // Reinício com parada herdada: `parar_em` provisório já na linha, para a ponta que começar
    // durante o reinício saber o que faltava (a partida grava o definitivo).
    const pararEmProvisorio = typeof restanteParadaMs === 'number' ? new Date(Date.now() + restanteParadaMs) : null;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, usuario_id, origem, irrigacao, retomar, parar_em)
        VALUES (${seqId}, ${id}::bpchar, ${acao}, 'executando', ${autorId}, ${origem},
          ${irrigacao ? JSON.stringify(irrigacao) : null}::jsonb, ${opts.retomar ? JSON.stringify(opts.retomar) : null}::jsonb, ${pararEmProvisorio})`;
      // Nova tentativa de um Desligar que não desligou a bomba: sem repetir a linha na trilha a cada vez.
      if (!(acao === 'desligar' && this.bombaPresa.has(id))) await this.trilha(id, acao === 'desligar'
        ? `Desligar${opts.motivo ? ` · ${opts.motivo}` : ''}`
        : reiniciar
          // Trilha do reinício: o que estava girando → o que passa a valer (busca por "Reiniciar").
          ? `Reiniciar com novas opções · ${resumoIrrigacao(antesDoReinicio)} → ${resumoIrrigacao(irrigacao)}${opts.motivo ? ` · ${opts.motivo}` : ''}`
          : `Ligar · ${resumoIrrigacao(irrigacao)}${opts.motivo ? ` · ${opts.motivo}` : ''}`, autorId, origem, 'INFO', cliente?.dispositivo);
    } catch (e) {
      if (this.rodando.get(id) === ctl) this.rodando.delete(id);
      throw e;
    }
    void this.executar(id, acao, ctl, user, cliente, irrigacao, { reiniciar, restanteParadaMs, paraSemGiro, origem }).finally(() => {
      if (this.rodando.get(id) === ctl) this.rodando.delete(id);
    });
    return { sequencia_id: seqId, status: 'executando' };
  }

  // ------------------------------------------------------------------ travas
  /**
   * Estado do pivô para as travas de comando, pelas entradas de status da TON:
   * 'girando' (algum Girando = 1), 'parado' (Desligado = 1 ou todos os Girando = 0),
   * 'desconhecido' (status cadastrado sem leitura) ou 'sem_status' (nada cadastrado).
   * Girando e Desligado ao mesmo tempo conta como girando (o lado seguro das travas).
   */
  private async estadoTrava(pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }) {
    const giro = (['direita', 'esquerda'] as const).filter((k) => pts.st[k]);
    if (!giro.length && !pts.st.desligado) return { estado: 'sem_status' as const, sentido: null, erro: null as 0 | 1 | null };
    const st = await this.statusPivo(pts);
    const sentido = st.direita === 1 ? 'direita' : st.esquerda === 1 ? 'esquerda' : null;
    if (sentido) return { estado: 'girando' as const, sentido, erro: st.erro };
    if (st.desligado === 1 || (giro.length > 0 && giro.every((k) => st[k] === 0))) return { estado: 'parado' as const, sentido: null, erro: st.erro };
    return { estado: 'desconhecido' as const, sentido: null, erro: st.erro };
  }

  /** null = pode ligar; senão o motivo da recusa. */
  private async travaLigar(id: string, pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }): Promise<string | null> {
    const t = await this.estadoTrava(pts);
    if (t.erro === 1) return 'Pivô sinalizando ERRO — verifique no painel antes de ligar.';
    if (t.estado === 'girando') return `O pivô já está girando para a ${t.sentido}. Desligue antes de ligar de novo ou inverter o sentido.`;
    if (t.estado === 'desconhecido') return 'Sem leitura do status do pivô (entradas da TON): não dá para confirmar que está parado.';
    // Sem entradas de status: vale o que o NexON comandou.
    if (t.estado === 'sem_status' && (await this.irrigacaoAtiva(id))) return 'O pivô já está ligado. Desligue antes de ligar de novo ou inverter o sentido.';
    // Irrigando PARADO (só a bomba, sem giro): o status diz "parado", mas o pivô está ligado.
    if (t.estado === 'parado' && (await this.irrigacaoAtiva(id))?.irrigacao?.config?.semGiro) {
      return 'O pivô já está ligado, irrigando parado. Desligue antes, ou mude as opções em "Desligar ou modificar".';
    }
    return null;
  }

  /**
   * null = pode reiniciar (desligar e ligar de novo com outras opções); senão o motivo.
   * Só com o pivô LIGADO: girando pelo status da TON ou, sem entradas de status, com a
   * irrigação que o NexON comandou em curso.
   */
  private async travaReiniciar(id: string, pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }): Promise<string | null> {
    const t = await this.estadoTrava(pts);
    if (t.erro === 1) return 'Pivô sinalizando ERRO — verifique no painel antes de reiniciar.';
    if (t.estado === 'desconhecido') return 'Sem leitura do status do pivô (entradas da TON): não dá para confirmar que está ligado.';
    if (t.estado === 'parado' || t.estado === 'sem_status') {
      const at = await this.irrigacaoAtiva(id);
      // parado pelo status só conta como ligado se estiver irrigando parado (só a bomba)
      if (t.estado === 'parado' ? !at?.irrigacao?.config?.semGiro : !at) return 'O pivô não está ligado. Use Ligar.';
    }
    return null;
  }

  /**
   * null = pode desligar; senão o motivo. Parar com estado DESCONHECIDO (sem status ou
   * sem leitura) é sempre permitido — bloquear impediria parar um pivô ligado no painel.
   * Também pode quando há partida em curso, início agendado ou a bomba ligada.
   */
  private async travaDesligar(id: string, pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }, cfg: { bombeamento: Bombeamento | null }): Promise<string | null> {
    if (this.rodando.has(id)) return null;
    const ag = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pivo_sequencias WHERE equipamento_id = ${id}::bpchar AND status = 'agendada'`;
    if ((ag[0]?.n ?? 0) > 0) return null;
    const b = cfg.bombeamento;
    if (b && (await this.bombaLigada(b)) === 1) return null;
    // Irrigando parado sem BI da bomba: o status diz "parado", mas a irrigação está em curso.
    if (await this.irrigacaoAtiva(id)) return null;
    const t = await this.estadoTrava(pts);
    return t.estado === 'parado' ? 'O pivô já está desligado.' : null;
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
    if (r.irrigacao?.config?.semGiro === true) {
      // Irrigando PARADO (só a bomba): o status do pivô diz "parado" de propósito. Quem diz se
      // segue em curso é a bomba — desligada (leitura 0), a irrigação acabou fora do NexON e a
      // linha é encerrada, para não "voltar" quando outro pivô ligar a mesma bomba. Sem BI da
      // bomba (leitura nula), vale o que o NexON comandou.
      if (r.status === 'concluida') {
        const b = (await this.lerConfig(id)).bombeamento;
        const lida = b ? await this.bombaLigada(b) : null;
        if (lida === 0) {
          // Uma leitura só não fecha (ruído, BI atrasada): a bomba tem de aparecer desligada por
          // 1 min seguido. Até lá a irrigação segue contando como em curso.
          // A contagem é DESTA linha: sobra de uma irrigação anterior não vale.
          const antes = this.bombaZeroDesde.get(id);
          const desde = antes && antes.linhaId === r.id ? antes.desde : Date.now();
          this.bombaZeroDesde.set(id, { linhaId: r.id, desde });
          if (Date.now() - desde >= BOMBA_DESLIGADA_SUSTENTADA_MS) {
            this.bombaZeroDesde.delete(id);
            await this.encerrarSemGiro(id, r.id);
            return null;
          }
        } else this.bombaZeroDesde.delete(id);
      }
    } else {
      const st = await this.statusPivo(await this.pontos(id));
      if (r.status === 'concluida' && (st.desligado === 1 || (st.direita === 0 && st.esquerda === 0))) return null;
    }
    return { id: r.id, acao: r.acao, irrigacao: r.irrigacao ?? null, parar_em: r.parar_em ?? null, usuario_id: r.usuario_id ?? null, created_at: r.created_at };
  }

  /** Tentativas seguidas de Desligar em que a bomba não confirmou desligada (por pivô), para não encher a trilha. */
  private readonly bombaPresa = new Map<string, { vezes: number; ultima: number }>();

  /**
   * Um Desligar automático (parada por tempo, ponta) de irrigação parada não desligou a bomba:
   * dá para tentar de novo agora? Três tentativas seguidas e depois uma a cada 5 min — sem isso
   * seria um comando na bomba a cada 30 s, para sempre.
   */
  podeTentarDesligar(id: string): boolean {
    const p = this.bombaPresa.get(id.trim());
    if (!p) return true;
    if (Date.now() - p.ultima > 30 * 60000) { this.bombaPresa.delete(id.trim()); return true; }   // incidente antigo
    return p.vezes < 3 || Date.now() - p.ultima >= 5 * 60000;
  }

  /** Desligar de irrigação parada que não desligou a bomba: conta, e avisa na trilha na 1ª vez e a cada 10. */
  private async bombaNaoDesligou(id: string, motivo: string, autor: string | null, origem: OrigemSequencia) {
    const antes = this.bombaPresa.get(id);
    const vezes = (antes && Date.now() - antes.ultima <= 30 * 60000 ? antes.vezes : 0) + 1;
    this.bombaPresa.set(id, { vezes, ultima: Date.now() });
    if (vezes === 1 || vezes % 10 === 0) {
      await this.trilha(id, `Desligar NÃO concluiu: ${motivo}${vezes > 1 ? ` (${vezes} tentativas)` : ''} — confira a bomba no painel`, autor, origem, 'ALTA');
    }
    this.logger.warn(`[pivo-seq] ${id} desligar: ${motivo} (tentativa ${vezes})`);
  }
  private readonly encerrando = new Set<string>();
  /** Desde quando a bomba de uma irrigação parada aparece desligada (por pivô). */
  private readonly bombaZeroDesde = new Map<string, { linhaId: string; desde: number }>();
  /**
   * A bomba de uma irrigação parada (só a bomba) ficou desligada: registra o fim. Só grava se a
   * linha lida AINDA é a última do pivô — dois leitores juntos, ou um Ligar novo no meio, não
   * criam um "desligar" a mais que esconderia a irrigação nova.
   */
  private async encerrarSemGiro(id: string, linhaId: string) {
    if (this.encerrando.has(id)) return;
    this.encerrando.add(id);
    try {
      const passos: Passo[] = [{ t: new Date().toISOString(), etapa: 'bomba', msg: 'Bomba desligada fora do NexON — irrigação parada encerrada', ok: true }];
      const n = await this.prisma.$executeRaw`
        INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, origem, passos, finished_at)
        SELECT ${novoId26()}, ${id}::bpchar, 'desligar', 'concluida', 'parada', ${JSON.stringify(passos)}::jsonb, now()
        WHERE (SELECT TRIM(u.id) FROM pivo_sequencias u WHERE u.equipamento_id = ${id}::bpchar AND u.status NOT IN ('agendada', 'cancelada')
               ORDER BY u.created_at DESC LIMIT 1) = ${linhaId}`;
      if (n) await this.trilha(id, 'Irrigação parada encerrada: a bomba foi desligada fora do NexON', null, 'parada', 'WARN');
    } catch (e: any) {
      this.logger.warn(`[pivo-seq] ${id} encerrar irrigação parada: ${e?.message}`);
    } finally {
      this.encerrando.delete(id);
    }
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

  /** Ângulo atual do pivô (encoder ou telemetria, leitura até 15 min), ou null. */
  async anguloAtual(id: string): Promise<number | null> {
    return (await this.posicao(id)).angulo;
  }

  /**
   * Posição do pivô. Com encoder na Configuração (encoder_equipamento_id): última
   * leitura do encoder, convertida em ângulo pela resolução, sentido e zero
   * (pivo-posicao.util). Leitura com mais de 15 min não vale (ângulo null + motivo):
   * a parada por ângulo e a previsão não podem usar posição velha.
   * Sem encoder: `angulo` da própria telemetria do pivô (legado).
   */
  async posicao(id: string): Promise<PosicaoPivo> {
    const cfg = await this.prisma.$queryRaw<Array<{ parametros: any }>>`
      SELECT parametros FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`.catch(() => []);
    const enc = parametrosEncoder(cfg[0]?.parametros);
    const deId = enc.equipamentoId ?? id;
    const rows = await this.prisma.$queryRaw<Array<{ dados: any; ts: Date }>>`
      SELECT dados, timestamp_dados AS ts FROM equipamentos_dados WHERE equipamento_id = ${deId}::bpchar
      ORDER BY timestamp_dados DESC LIMIT 1`.catch(() => []);
    const ult = rows[0];
    const velha = !ult || Date.now() - new Date(ult.ts).getTime() > 15 * 60_000;
    const lidoEm = ult?.ts ?? null;

    if (!enc.equipamentoId) {
      const d = ult?.dados;
      const v = Number(d?.angulo ?? d?.posicao ?? d?.data?.angulo);
      const ok = !velha && d && Number.isFinite(v);
      return { fonte: 'telemetria', angulo: ok ? v : null, angulo_sem_zero: null, bruto: null, lido_em: lidoEm, motivo: ok ? null : 'Sem posição na telemetria do pivô', encoder: null, sem_calibracao: false, calibracao: null };
    }
    const cal = await calibracaoVigente(this.prisma, id);
    const calibracao = cal ? { id: cal.id, az_cal: cal.az_cal, bruto_cal: cal.bruto_cal, sentido: cal.sentido, criado_em: cal.criado_em } : null;
    const encoder = { equipamento_id: enc.equipamentoId, resolucao: enc.resolucao, invertido: enc.invertido, zero: enc.zero };
    const bruto = brutoDoEncoder(ult?.dados);
    const semAngulo = (motivo: string) => ({ fonte: 'encoder' as const, angulo: null, angulo_sem_zero: null, bruto, lido_em: lidoEm, motivo, encoder, sem_calibracao: !cal, calibracao });
    if (enc.resolucao == null) return semAngulo('Resolução do encoder não configurada');
    if (!ult) return semAngulo('Encoder ainda sem leitura');
    if (velha) return semAngulo('Encoder sem leitura há mais de 15 min');
    if (bruto == null) return semAngulo('Leitura do encoder sem o campo posicao');
    // Sem calibração ativa a contagem não diz para onde o braço aponta: só o bruto, com aviso.
    if (!cal) return semAngulo('Sem calibração: mostrando só a leitura bruta do encoder');
    const a = anguloDoEncoder(bruto, enc)!;
    return { fonte: 'encoder', angulo: a.angulo, angulo_sem_zero: a.anguloSemZero, bruto, lido_em: lidoEm, motivo: null, encoder, sem_calibracao: false, calibracao };
  }

  /**
   * O que os alarmes do ângulo (NEXON-103) precisam saber do giro agora: o lado comandado
   * lido das entradas, o percentímetro em curso e a TON que executa (viva ou não).
   */
  async giroAtual(id: string): Promise<{ dir: 'D' | 'E' | null; lido: boolean; percentual: number | null; ton: { em: Date; e: number } | null }> {
    const pts = await this.pontos(id);
    const st = await this.statusPivo(pts);
    const ton = await this.tonLocal(pts).catch(() => null);
    const ativa = await this.irrigacaoAtiva(id).catch(() => null);
    const pct = ton && ton.e !== 0 && Number.isFinite(ton.pm) ? ton.pm / 10 : Number(ativa?.irrigacao?.config?.percentual);
    return {
      dir: st.direita === 1 ? 'D' : st.esquerda === 1 ? 'E' : null,
      lido: st.direita !== null && st.esquerda !== null,
      percentual: Number.isFinite(pct) && pct > 0 ? pct : null,
      ton: ton ? { em: ton.em, e: ton.e } : null,
    };
  }

  /** Lâmina a 100 % (mm) e ciclo do percentímetro (s, padrão 60) da Configuração. */
  async parametrosPercentimetro(id: string): Promise<{ lamina100: number | null; cicloS: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ parametros: any }>>`
      SELECT parametros FROM pivo_config WHERE equipamento_id = ${id}::bpchar LIMIT 1`.catch(() => []);
    const l = Number(rows[0]?.parametros?.lamina_100);
    const c = Number(rows[0]?.parametros?.percentimetro_ciclo_s);
    return { lamina100: l > 0 ? l : null, cicloS: c >= 5 && c <= 600 ? Math.round(c) : 60 };
  }

  /**
   * Percentímetro na TON: um comando ("perc <bo> <permil> <ciclo_s> <mascara>" ou "perc off").
   * A máscara são as DINs de "Girando" (mesma TON, não invertidas): a TON só roda o ciclo com
   * o pivô ligado no painel. Ack tem que confirmar o valor — firmware antigo = erro (regravar).
   * Sem ponto Percentímetro, ou ponto sem BO vinculada (o tipo Pivô traz o ponto marcado por
   * padrão; pivô sem percentímetro na TON não pode deixar de partir) → false (ajuste no painel).
   */
  private async percentimetro(
    id: string,
    pts: { cmd: Partial<Record<string, string>>; st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> },
    permil: number | 'off',
    user?: Autor, cliente?: ClienteInfo,
  ): Promise<{ bo: number; cicloS: number } | false> {
    const pid = pts.cmd.percentimetro;
    if (!pid) return false;
    const m = await this.boDoPonto(pid);
    if (!m) return false;
    // Pivô ligado pela sequência na TON: o percentímetro é dela (o "perc" antigo é recusado).
    if (this.ton?.ligadaNaTon(m.ton_id)) {
      if (permil === 'off') return { bo: m.bo, cicloS: 0 };   // a TON zera no Desligar
      const pmT = Math.max(0, Math.min(1000, Math.round(permil)));
      await this.cmd.comandoTon({ equipamentoId: id, tonId: m.ton_id, cmd: `pivo perc ${pmT}`, rotulo: `Percentímetro ${fmtPercentual(pmT / 10)}%`, ackOk: new RegExp(`^pivo_perc_${pmT}$`) }, user, cliente);
      return { bo: m.bo, cicloS: (await this.parametrosPercentimetro(id)).cicloS };
    }
    if (permil === 'off') {
      await this.cmd.comandoTon({ equipamentoId: id, tonId: m.ton_id, cmd: 'perc off', rotulo: 'Percentímetro desligado', ackOk: /^perc_off$/ }, user, cliente);
      return { bo: m.bo, cicloS: 0 };
    }
    const { cicloS } = await this.parametrosPercentimetro(id);
    let mask = 0;
    for (const k of ['direita', 'esquerda'] as const) {
      const g = pts.st[k];
      if (g && g.ton_id === m.ton_id && !g.inv && g.bi >= 1 && g.bi <= 8) mask |= 1 << (g.bi - 1);
    }
    const pm = Math.max(0, Math.min(1000, Math.round(permil)));
    await this.cmd.comandoTon({
      equipamentoId: id, tonId: m.ton_id, cmd: `perc ${m.bo} ${pm} ${cicloS} ${mask}`,
      rotulo: `Percentímetro ${fmtPercentual(pm / 10)}%`, ackOk: new RegExp(`^perc_${m.bo}_${pm}$`),
    }, user, cliente);
    return { bo: m.bo, cicloS };
  }

  /** Status (BI) de um ponto do pivô, respeitando "invertido"; null = sem ponto ou sem leitura. */
  private async lerStatus(m: MapaBi | undefined): Promise<0 | 1 | null> {
    if (!m) return null;
    const v = (await this.cmd.lerEntradaTon(m.ton_id, m.bi)).valor;
    return v === null ? null : ((m.inv ? 1 - v : v) as 0 | 1);
  }

  /**
   * Canhão final: o ponto Canhao é um botão que ALTERNA (pulso) e o Canhao_ligado diz o
   * estado. Só pulsa quando o estado lido é diferente do pedido, e confirma pelo status.
   * Sem o status (ou sem leitura) não comanda: às cegas o pulso pode desligar em vez de ligar.
   */
  private async aplicarCanhao(
    id: string,
    pts: { cmd: Partial<Record<PapelComando, string>>; st: Partial<Record<PapelStatus, MapaBi>> },
    ligar: boolean, user: Autor | undefined, cliente: ClienteInfo | undefined,
    segundos: number, ctl: { cancelar: boolean } = { cancelar: false },
  ): Promise<ResCanhao> {
    if (!pts.cmd.canhao) return 'sem_ponto';
    const alvo = ligar ? 1 : 0;
    // Pivô ligado pela sequência na TON: o canhão é dela ("pivo canhao"); o status só confirma.
    const mCan = this.ton ? await this.boDoPonto(pts.cmd.canhao) : null;
    if (mCan && this.ton?.ligadaNaTon(mCan.ton_id)) {
      await this.cmd.comandoTon({ equipamentoId: id, tonId: mCan.ton_id, cmd: `pivo canhao ${alvo}`, rotulo: ligar ? 'Canhão ligado' : 'Canhão desligado', ackOk: /^pivo_canhao_(on|off)$/ }, user, cliente);
      if (!pts.st.canhao) return 'enviado';
      const okT = await this.esperar(async () => (await this.lerStatus(pts.st.canhao)) === alvo, segundos, ctl);
      return okT ? 'ok' : 'nao_confirmou';
    }
    if (await this.mantido(id)) {
      // Saída mantida: a BO É o canhão (on = ligado). Manda SEMPRE o nível pedido; o status, se
      // houver, só confirma. Antes um Canhao_ligado lendo 1 (entrada presa, bancada) fazia o NexON
      // responder "já ligado" sem nunca energizar a saída — a ficha dizia ligado e o canhão não ligava.
      await this.saidaMantida(id, pts.cmd.canhao, ligar, ligar ? 'Canhão ligado' : 'Canhão desligado', user, cliente);
      if (!pts.st.canhao) return 'enviado';
      const okM = await this.esperar(async () => (await this.lerStatus(pts.st.canhao)) === alvo, segundos, ctl);
      return okM ? 'ok' : 'nao_confirmou';
    }
    if (!pts.st.canhao) return 'sem_status';
    const atual = await this.lerStatus(pts.st.canhao);
    if (atual === null) return 'sem_leitura';
    if (atual === alvo) return 'ja';
    await this.cmd.acionarPonto(id, pts.cmd.canhao, user, false, undefined, cliente);
    const ok = await this.esperar(async () => (await this.lerStatus(pts.st.canhao)) === alvo, segundos, ctl);
    return ok ? 'ok' : 'nao_confirmou';
  }

  /** Ativar/desativar o canhão pela ficha (pivô ligado com água). */
  async comandarCanhao(pivoId: string, ligar: boolean, user?: Autor, cliente?: ClienteInfo) {
    const id = await this.assertPivo(pivoId, user);
    const eq = await this.prisma.equipamentos.findFirst({ where: { id }, select: { nome: true, automacao: true } });
    if (!eq?.automacao) throw new BadRequestException(`"${eq?.nome?.trim()}" não tem automação habilitada.`);
    if (this.rodando.has(id)) throw new ConflictException('Sequência do pivô em andamento — aguarde terminar.');
    const pts = await this.pontos(id);
    if (!pts.cmd.canhao) throw new BadRequestException('O pivô não tem o ponto Canhao ligado a uma BO (Topologia IoT → Configurar I/O).');
    const mant = await this.mantido(id);
    if (!pts.st.canhao && !mant) throw new BadRequestException('Ligue o status Canhao_ligado a uma BI: sem ele o NexON não comanda o canhão (o botão do painel alterna).');
    if (pts.st.canhao) {
      const atual = await this.lerStatus(pts.st.canhao);
      if (atual === null && !mant) throw new ConflictException('Sem leitura do Canhao_ligado — não dá para saber o estado do canhão.');
      if (atual === (ligar ? 1 : 0)) throw new ConflictException(ligar ? 'O canhão já está ligado.' : 'O canhão já está desligado.');
    }
    if (ligar) {
      const st = await this.statusPivo(pts);
      const ativa = await this.irrigacaoAtiva(id);
      const girando = st.direita === 1 || st.esquerda === 1 || (!!ativa && st.direita === null && st.esquerda === null);
      if (!girando) throw new ConflictException('Ligue o pivô antes de ligar o canhão.');
      if (ativa?.irrigacao?.config?.semAgua) throw new ConflictException('Girando sem água: o canhão fica desligado.');
    }
    const s = (await this.lerConfig(id)).sequencia.confirma_giro_s;
    const r = await this.aplicarCanhao(id, pts, ligar, user, cliente, s);
    await this.trilha(id, MSG_CANHAO[r](ligar, s), user?.id?.trim() || null, 'manual', r === 'ok' ? 'INFO' : 'WARN');
    if (r === 'nao_confirmou') throw new ConflictException(`Comando enviado, mas o canhão não confirmou ${ligar ? 'ligado' : 'desligado'} em ${s}s.`);
    return { ok: true, ligado: ligar ? 1 : 0 };
  }

  /**
   * Muda o percentímetro com o pivô irrigando, sem desligar: um `perc` novo e a TON
   * aplica no próximo ciclo. Atualiza a irrigação em curso e reescala a parada por
   * voltas/ângulo (o que falta percorrer anda na velocidade nova); por tempo não muda.
   */
  async ajustarPercentimetro(pivoId: string, body: { percentual?: unknown; lamina?: unknown }, user?: Autor, cliente?: ClienteInfo) {
    const id = await this.assertPivo(pivoId, user);
    const eq = await this.prisma.equipamentos.findFirst({ where: { id }, select: { nome: true, automacao: true } });
    if (!eq?.automacao) throw new BadRequestException(`"${eq?.nome?.trim()}" não tem automação habilitada.`);
    if (this.rodando.has(id)) throw new ConflictException('Sequência do pivô em andamento — aguarde terminar.');
    const pts = await this.pontos(id);
    if (!pts.cmd.percentimetro) throw new BadRequestException('O pivô não tem o ponto Percentimetro ligado a uma BO (Topologia IoT → Configurar I/O): o ajuste fica no painel.');
    const ativa = await this.irrigacaoAtiva(id);
    const irr = ativa?.irrigacao;
    if (!ativa || !irr) throw new ConflictException('O pivô não está irrigando. Ligue com o percentual desejado.');
    if (irr.config.semAgua) throw new ConflictException('Girando sem água: o percentímetro fica em 100 %.');
    // Irrigando parado só com a bomba: o pivô nunca recebeu giro, então não há percentímetro para
    // trocar. Antes respondia 200 e regravava o registro sem mandar nada à TON.
    if (irr.config.semGiro) throw new ConflictException('O pivô está irrigando parado (só a bomba). Para voltar a girar, salve e envie pelo Planejamento.');

    const lamina = Number(body?.lamina) > 0 ? Math.round(Number(body.lamina) * 100) / 100 : null;
    let pct: number;
    if (lamina) {
      const { lamina100 } = await this.parametrosPercentimetro(id);
      if (!lamina100) throw new BadRequestException('Cadastre a "Lâmina a 100%" na Configuração do pivô para ajustar por lâmina (ou informe o percentual).');
      const p = percentualDaLamina(lamina, lamina100);
      if (p === null) throw new BadRequestException(`Lâmina mínima deste pivô: ${String(lamina100).replace('.', ',')} mm (100 %).`);
      pct = p;
    } else {
      if (body?.percentual === undefined || body?.percentual === null || body?.percentual === '') throw new BadRequestException('Informe o percentual ou a lâmina.');
      pct = normalizarPercentual(body.percentual);
    }
    const antes = irr.config.percentual;
    if (pct === antes) throw new ConflictException(`O percentímetro já está em ${fmtPercentual(pct)}%.`);

    const aplicou = await this.percentimetro(id, pts, pct * 10, user, cliente);
    if (aplicou === false) throw new BadRequestException('O ponto Percentimetro não está ligado a uma BO (Topologia IoT → Configurar I/O): o ajuste fica no painel.');

    // Parada por voltas/ângulo: o que falta percorrer, na velocidade nova (0 % = não chega).
    let pararEm = ativa.parar_em;
    if (pararEm && irr.parada.tipo !== 'porTempo') {
      const resta = new Date(pararEm).getTime() - Date.now();
      pararEm = pct > 0 && antes > 0 && resta > 0 ? new Date(Date.now() + Math.round(resta * (antes / pct))) : pct > 0 ? pararEm : null;
    }
    irr.config.percentual = pct;
    irr.config.lamina = lamina;
    await this.prisma.$executeRaw`
      UPDATE pivo_sequencias SET irrigacao = ${JSON.stringify(irr)}::jsonb, parar_em = ${pararEm} WHERE id = ${ativa.id}`;
    await this.trilha(id, `Percentímetro ajustado com o pivô girando: ${fmtPercentual(antes)}% → ${fmtPercentual(pct)}%${lamina ? ` (lâmina ${lamina.toFixed(2).replace('.', ',')} mm)` : ''} · vale no próximo ciclo`, user?.id?.trim() || null, 'manual');
    return { ok: true, percentual: pct, lamina, parar_em: pararEm };
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
  async trilha(id: string, mensagem: string, usuarioId: string | null, origem: OrigemSequencia, severidade = 'INFO', dispositivo?: string | null) {
    const rotulo: Record<OrigemSequencia, string> = {
      manual: '', agendada: 'Agendamento', programacao: 'Programação', ponta: 'Horário de ponta', ponta_retomada: 'Fim da ponta', parada: 'Parada automática',
    };
    try {
      const log = await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: id, severidade, status: 'gravado',
          mensagem: `${rotulo[origem] ? `${rotulo[origem]}: ` : ''}${mensagem}`.slice(0, 500),
          usuario_id: usuarioId, comando_semantico: `pivo.${origem}`,
        },
      });
      // Aparelho de quem comandou (web, app), como nas linhas de comando do equipamentos-cmd.
      if (dispositivo && log?.id != null) {
        await this.prisma.$executeRaw`UPDATE logs_mqtt SET dispositivo = ${dispositivo} WHERE id = ${log.id}::bpchar`.catch((e) =>
          this.logger.warn(`[pivo-trilha] dispositivo não gravado: ${(e as Error).message}`));
      }
    } catch (e: any) {
      this.logger.warn(`[pivo-trilha] ${id}: ${e?.message}`);
    }
  }

  // ------------------------------------------------------------------ execução
  private async executar(id: string, acao: AcaoPivo, ctl: { seqId: string; cancelar: boolean; finalizando?: boolean }, user?: Autor, cliente?: ClienteInfo, irr: Irrigacao | null = null,
    extra: { reiniciar?: boolean; restanteParadaMs?: number | null; paraSemGiro?: boolean; origem?: OrigemSequencia } = {}) {
    const paraSemGiro = extra.paraSemGiro === true;
    const origemSeq: OrigemSequencia = extra.origem ?? 'manual';
    const reiniciar = extra.reiniciar === true;
    /** Passo do canhão no Ligar: definido lá dentro, executado depois de gravar a parada automática. */
    let canhaoNoInicio: (() => Promise<void>) | null = null;
    const passos: Passo[] = [];
    const passo = async (etapa: string, msg: string, ok: boolean | null) => {
      passos.push({ t: new Date().toISOString(), etapa, msg, ok });
      await this.prisma.$executeRaw`UPDATE pivo_sequencias SET passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const fim = async (status: 'concluida' | 'falhou' | 'interrompida' | 'cancelada', erro?: string) => {
      await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET status = ${status}, erro = ${erro ?? null}, finished_at = now(),
          passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const msgErro = (e: any) => e?.response?.message || e?.message || String(e);
    let percEnviado = false;   // percentímetro já configurado na TON nesta partida
    let desligarEnviado = false;   // Desligar do pivô já mandado (a bomba de pontos para junto)
    let desligarPivoEnviado = false;   // idem, dentro do parar(): só vale se o comando foi aceito
    // Reinício: em que ponto a sequência está, para o catch saber o que desfazer/completar.
    let faseReinicio: 'antes' | 'parando' | 'depois' = 'antes';
    // Comando de parada que PODE ter chegado ao pivô: vale desde o envio — um timeout (504)
    // pode ser só o ack perdido, com o Desligar executado. Só volta a false se o erro prova
    // que nada saiu (recusa 400/403/404 ou broker fora, 503) e nenhum outro já foi aceito.
    let paradaEnviada = false;
    let paradaAceita = false;
    const naoSaiu = (e: any) => [400, 403, 404, 503].includes(Number(e?.getStatus?.() ?? e?.status));
    const mandarParada = async (fn: () => Promise<unknown>) => {
      paradaEnviada = true;
      try { await fn(); paradaAceita = true; } catch (e) { if (naoSaiu(e) && !paradaAceita) paradaEnviada = false; throw e; }
    };

    try {
      const cfg = await this.lerConfig(id);
      const pts = await this.pontos(id);
      const b = cfg.bombeamento;

      // Fase 3: a TON do pivô tem a sequência local → ela executa tudo; o NexON só acompanha.
      const alvoTon = this.ton ? await this.ton.alvo(id, user, cliente).catch(() => null) : null;
      if (alvoTon && this.ton) {
        const params = await this.parametrosPercentimetro(id).catch(() => ({ cicloS: 60, lamina100: null }));
        await this.ton.executar({
          pivoId: id, seqId: ctl.seqId, acao, irr, ctl, reiniciar, restanteParadaMs: extra.restanteParadaMs,
          sequencia: cfg.sequencia, cicloPercS: params.cicloS, tempoVolta100h: await this.tempoVolta100(id).catch(() => 6),
          anguloAtual: await this.anguloAtual(id).catch(() => null), passo, fim, user, cliente,
        }, alvoTon);
        return;
      }

      const mant = cfg.sequencia.comandos_mantidos;
      /**
       * O Desligar inteiro: para o pivô, desliga o canhão e a bomba. Devolve a confirmação da
       * parada — true = parado, false = não confirmou no tempo, null = sem status para confirmar.
       */
      const parar = async (): Promise<boolean | null> => {
        let parou: boolean | null = null;
        if (mant && (pts.cmd.direita || pts.cmd.esquerda)) {
          // Saídas mantidas: baixa as BOs de giro (o pivô para); a bomba desliga em desligarBomba.
          for (const k of ['direita', 'esquerda'] as const) {
            if (pts.cmd[k]) await mandarParada(() => this.saidaMantida(id, pts.cmd[k], false, `Girar ${k} desligado`, user, cliente));
          }
          await passo('pivo', 'Saídas de giro desligadas', true);
          parou = await this.esperar(async () => {
            const t = await this.estadoTrava(pts);
            return t.estado === 'sem_status' ? null : t.estado === 'parado';
          }, cfg.sequencia.confirma_giro_s, ctl);
          await passo('pivo', parou === null ? 'Pivô sem status cadastrado — sem confirmação' : parou ? 'Pivô parado' : 'Pivô não confirmou parada no tempo', parou !== false);
        } else if (paraSemGiro && pts.cmd.desligar && b && b.origem !== 'pontos') {
          // Parando uma irrigação PARADA (só a bomba; o pivô nunca recebeu giro) com bomba de
          // saída própria: o Desligar do pivô é melhor esforço — se a TON dele não responder, a
          // bomba desliga do mesmo jeito. Só neste caso: num pivô que pode estar girando, um
          // Desligar sem resposta continua abortando (desligar a bomba o deixaria a seco).
          paradaEnviada = true;
          const foi = await this.cmd.acionarPonto(id, pts.cmd.desligar, user, false, undefined, cliente).then(() => true).catch(() => false);
          desligarPivoEnviado = foi;
          await passo('pivo', foi ? 'Comando Desligar enviado ao pivô (já estava parado)' : 'Pivô já parado — o Desligar dele ficou sem resposta; seguindo para a bomba', foi ? true : null);
          parou = true;
        } else if (pts.cmd.desligar) {
          await mandarParada(() => this.cmd.acionarPonto(id, pts.cmd.desligar!, user, false, undefined, cliente));
          desligarPivoEnviado = true;
          await passo('pivo', 'Comando Desligar enviado ao pivô', true);
          // Mesma regra das travas: parado = Desligado = 1 ou todos os Girando LIGADOS em 0
          // (pivô com só um Girando cadastrado também confirma).
          parou = await this.esperar(async () => {
            const t = await this.estadoTrava(pts);
            return t.estado === 'sem_status' ? null : t.estado === 'parado';
          }, cfg.sequencia.confirma_giro_s, ctl);
          await passo('pivo', parou === null ? 'Pivô sem status cadastrado — sem confirmação' : parou ? 'Pivô parado' : 'Pivô não confirmou parada no tempo', parou !== false);
        }
        const desligarCanhao = async () => {
          if (!(pts.cmd.canhao && (mant || (pts.st.canhao && (await this.lerStatus(pts.st.canhao)) === 1)))) return;
          const r = await this.aplicarCanhao(id, pts, false, user, cliente, cfg.sequencia.confirma_giro_s)
            .catch((x) => { this.logger.warn(`[pivo-seq] ${id} canhão: ${msgErro(x)}`); return 'nao_confirmou' as const; });
          await passo('canhao', MSG_CANHAO[r](false, cfg.sequencia.confirma_giro_s), r === 'ok' || r === 'ja');
          // Canhão que não desligou fica aberto para a próxima irrigação: avisa na trilha.
          if (r !== 'ok' && r !== 'ja') {
            await this.trilha(id, `${MSG_CANHAO[r](false, cfg.sequencia.confirma_giro_s)} — confira o canhão no painel`, (user as Autor | undefined)?.id?.trim() || null, origemSeq, 'WARN');
          }
        };
        if (mant) {
          // Saídas mantidas (TON no lugar do painel): a água corta ANTES. A espera do canhão
          // (até confirma_giro_s) não pode segurar a bomba ligada com o pivô já parado.
          try { if (b) await this.desligarBomba(id, b, passo, user, cliente, desligarPivoEnviado); }
          finally { await desligarCanhao(); }
        } else {
          await desligarCanhao();
          if (b) await this.desligarBomba(id, b, passo, user, cliente, desligarPivoEnviado);
        }
        return parou;
      };
      if (acao === 'desligar') {
        await parar();
        // Irrigação PARADA cuja bomba segue ligada depois do Desligar (e nenhum outro pivô a usa):
        // o Desligar NÃO concluiu. A linha sai de cena ('cancelada') para a irrigação voltar a
        // contar como em curso — o operador vê, pode desligar de novo, e a parada automática
        // tenta outra vez — em vez de o NexON dizer "desligado" com a água correndo no mesmo
        // lugar. Pivô girando segue como sempre: conclui, com o passo "não confirmou".
        if (paraSemGiro && b && b.bi_confirma && (await this.bombaLigada(b)) === 1 && !(await this.bombaEmUsoPor(id, b))) {
          await fim('cancelada', 'Desligar não concluiu: a bomba não confirmou desligada');
          await this.bombaNaoDesligou(id, 'a bomba não confirmou desligada', (user as Autor | undefined)?.id?.trim() || null, origemSeq);
          return;
        }
        this.bombaPresa.delete(id);
        await fim('concluida');
        ctl.finalizando = true;
        // `perc off` depois de concluir: com o Girando em 0 a TON já cortou a BO sozinha, o
        // comando só limpa o NVS. A tela mostra parado sem esperar mais uma volta no rádio;
        // a trava (rodando) segue até o ack, então um Ligar logo depois não cruza com ele.
        if (pts.cmd.percentimetro) {
          await this.percentimetro(id, pts, 'off', user, cliente)
            .then((ok) => (ok ? passo('percentimetro', 'Percentímetro desligado na TON', true) : undefined))
            .catch((x) => passo('percentimetro', `Percentímetro não desligou: ${msgErro(x)}`, false));
        }
        return;
      }

      // ---- reiniciar (NEXON-98): o Desligar inteiro e, só com a parada confirmada, a partida
      // normal abaixo com as novas opções. Qualquer dúvida sobre o estado NÃO religa — o pivô
      // fica desligado e a sequência termina em falha, como um Ligar que não partiu.
      if (reiniciar) {
        // Sem como parar o pivô, nada é comandado (o acionar já recusa; aqui é a segunda trava).
        if (!pts.cmd.desligar && !(mant && (pts.cmd.direita || pts.cmd.esquerda))) {
          throw new Error('Sem comando de parada cadastrado — reinício não executado.');
        }
        await passo('reinicio', 'Reinício com novas opções: desligando o pivô', null);
        faseReinicio = 'parando';
        const parou = await parar();
        faseReinicio = 'depois';
        if (ctl.cancelar) return await this.interrompida(passo, fim);
        if (parou === false) throw new Error('O pivô não confirmou a parada — não foi religado. Confira o painel e ligue de novo.');
        // Limpa o percentímetro antigo na TON, como no Desligar (a partida manda o novo).
        if (pts.cmd.percentimetro) await this.percentimetro(id, pts, 'off', user, cliente).catch(() => undefined);
        // A partida confia na leitura "bomba ligada" para pular a pressurização: se a bomba não
        // confirmou desligada, essa leitura pode ser velha e o pivô giraria a seco. Vale também
        // para o reinício SEM água: não religa "seco" com a bomba ainda ligada.
        if (b && b.bi_confirma && (await this.bombaLigada(b)) === 1 && !(await this.bombaEmUsoPor(id, b))) {
          throw new Error('A bomba não confirmou desligada — o pivô não foi religado. Confira o painel e ligue de novo.');
        }
        await passo('reinicio', parou === null
          ? `Sem status de parada — aguardando ${PAUSA_REINICIO_S}s antes de religar`
          : `Pivô parado — religando em ${PAUSA_REINICIO_S}s com as novas opções`, parou === null ? null : true);
        for (let i = 0; i < PAUSA_REINICIO_S && !ctl.cancelar; i++) await this.sleep(1000);
        if (ctl.cancelar) return await this.interrompida(passo, fim);
      }

      // ---- girar
      const sentido = acao === 'girar_direita' ? 'direita' : 'esquerda';
      const st0 = await this.statusPivo(pts);
      if (st0.erro === 1) throw new Error('Pivô sinalizando ERRO — verifique no painel antes de partir.');

      let liguei = false;
      if (irr?.config.semAgua) await passo('bomba', 'Girar sem água: a bomba não liga', true);
      if (b && !irr?.config.semAgua) {
        const ligada = await this.bombaLigada(b);
        if (ligada === 1) {
          await passo('bomba', 'Bomba já ligada (sistema compartilhado) — sem esperar pressurização', true);
          if (await this.saidaMantida(id, pts.cmd.valvula, true, 'Válvula ON', user, cliente)) await passo('valvula', 'Válvula aberta (ON)', true);
        } else {
          await this.cmd.acionarBoDireto(
            { equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: b.modo === 'mantido' ? 'liga' : 'pulso', pulsoMs: b.pulso_ms, rotulo: b.origem === 'pontos' ? 'Ligar (bomba)' : 'Ligar bomba' },
            user, cliente,
          );
          liguei = true;
          await passo('bomba', 'Comando Ligar bomba enviado', true);
          if (await this.saidaMantida(id, pts.cmd.valvula, true, 'Válvula ON', user, cliente)) await passo('valvula', 'Válvula aberta (ON)', true);
          if (b.bi_confirma) {
            const ok = await this.esperar(async () => (await this.bombaLigada(b)) === 1, b.confirma_s ?? 30, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            if (!ok) throw new FalhaBomba(`Bomba não confirmou ligada em ${b.confirma_s ?? 30}s (BI${b.bi_confirma}).`);
            await passo('bomba', 'Bomba ligada (confirmado pela BI)', true);
          } else {
            await passo('bomba', 'Sem BI de confirmação da bomba — seguindo', null);
          }
          const pressS = cfg.sequencia.pressurizacao_s;
          // Espera fixa só sem pressostato e sem permissivo (os dois já confirmam a água).
          if (pressS > 0 && !pts.st.pressao && !pts.st.permissivo) {
            await passo('pressao', `Aguardando pressurização (${pressS}s)`, null);
            await this.esperar(async () => false, pressS, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            await passo('pressao', 'Pressurização concluída', true);
          }
        }
      }
      // Com água e pressostato cadastrado: só gira depois que a água chegou (com ou sem
      // bombeamento configurado — a pressão pode vir de outra fonte).
      if (!irr?.config.semAgua && pts.st.pressao) {
        const ps = pts.st.pressao;
        const limite = cfg.sequencia.pressurizacao_s > 0 ? cfg.sequencia.pressurizacao_s : 60;
        await passo('pressao', `Aguardando pressostato (até ${limite}s)`, null);
        const ok = await this.esperar(async () => {
          const v = (await this.cmd.lerEntradaTon(ps.ton_id, ps.bi)).valor;
          return v === null ? false : (ps.inv ? 1 - v : v) === 1;
        }, limite, ctl);
        if (ctl.cancelar) return await this.interrompida(passo, fim);
        if (!ok) throw new FalhaPartida(`Sem pressão: o pressostato não confirmou em ${limite}s.`, liguei);
        await passo('pressao', 'Pressão confirmada (pressostato)', true);
      }

      // Irrigando PARADO sem o ponto Percentímetro (`semGiro`): a bomba já está ligada e a água
      // chegou — o pivô não recebe comando de giro, então não há permissivo, percentímetro,
      // confirmação de giro nem canhão. A confirmação é a da bomba, acima.
      const semGiro = irr?.config.semGiro === true;
      if (semGiro) {
        if (ctl.cancelar) return await this.interrompida(passo, fim);
        await passo('pivo', 'Irrigando parado: a bomba está ligada e o pivô não gira', true);
      } else {
        // Permissivo para ligar (com ou sem água): o painel diz que pode partir — espera como o pressostato.
        if (pts.st.permissivo) {
          const pm = pts.st.permissivo;
          const limite = cfg.sequencia.pressurizacao_s > 0 ? cfg.sequencia.pressurizacao_s : 60;
          await passo('permissivo', `Aguardando permissivo para ligar (até ${limite}s)`, null);
          const ok = await this.esperar(async () => (await this.lerStatus(pm)) === 1, limite, ctl);
          if (ctl.cancelar) return await this.interrompida(passo, fim);
          if (!ok) throw new FalhaPartida(`Sem permissivo para ligar em ${limite}s (bomba, tensão, pressão no painel).`, liguei);
          await passo('permissivo', 'Permissivo para ligar confirmado', true);
        }

        // Percentímetro na TON ANTES de girar (a TON começa o ciclo quando o pivô ligar).
        // Sem água: 100 % (anda direto). Sem ponto Percentímetro: o ajuste fica no painel.
        const pctAlvo = irr?.config.semAgua ? 100 : irr?.config.percentual ?? 100;
        let pc: { bo: number; cicloS: number } | false = false;
        if (pts.cmd.percentimetro) {
          try {
            pc = await this.percentimetro(id, pts, pctAlvo * 10, user, cliente);
            percEnviado = !!pc;
          } catch (x) {
            throw new FalhaPartida(`Percentímetro: ${msgErro(x)}`, liguei);
          }
        }
        if (pc) {
          await passo('percentimetro', `Percentímetro ${fmtPercentual(pctAlvo)}%${irr?.config.lamina && !irr.config.semAgua ? ` (lâmina ${irr.config.lamina.toFixed(2).replace('.', ',')} mm)` : ''} aplicado na TON · ciclo ${pc.cicloS}s`, true);
        } else if (irr && !irr.config.semAgua) {
          await passo('pivo', `Percentímetro ${fmtPercentual(pctAlvo)}% (ajuste do painel do pivô)`, null);
        }

        if (ctl.cancelar) return await this.interrompida(passo, fim);
        if (mant) {
          // Saídas mantidas: o outro sentido em baixo ANTES (nunca os dois em alto), depois este em alto.
          const outro = sentido === 'direita' ? 'esquerda' : 'direita';
          if (pts.cmd[outro]) await this.saidaMantida(id, pts.cmd[outro], false, `Girar ${outro} desligado`, user, cliente);
          await this.saidaMantida(id, pts.cmd[sentido], true, `Girar ${sentido}`, user, cliente);
          await passo('pivo', `Girar ${sentido} ligado (saída mantida)`, true);
        } else {
          await this.cmd.acionarPonto(id, pts.cmd[sentido]!, user, false, undefined, cliente);
          await passo('pivo', `Comando Girar ${sentido} enviado ao pivô`, true);
        }
        const girou = await this.esperar(async () => {
          const s = await this.statusPivo(pts);
          return s[sentido] === null ? null : s[sentido] === 1;
        }, cfg.sequencia.confirma_giro_s, ctl);
        if (ctl.cancelar) return await this.interrompida(passo, fim);
        if (girou === false) {
          throw new FalhaGiro(`Pivô não confirmou "girando ${sentido}" em ${cfg.sequencia.confirma_giro_s}s.`, liguei);
        }
        await passo('pivo', girou === null ? `Sem status de giro cadastrado — comando enviado` : `Pivô girando ${sentido}`, girou === null ? null : true);
        // Canhão no início (só com água — normalizarIrrigacao já zera no seco). Não derruba a
        // irrigação: o pivô já está girando com água; a falha fica no passo E na trilha (o Ligar
        // diz "· canhão", então quem lê precisa saber que ele não ligou). Roda DEPOIS de gravar a
        // parada automática, abaixo: a espera do canhão leva até confirma_giro_s, e um reinício do
        // processo nessa janela deixaria o pivô girando sem parada marcada.
        if (irr && !irr.config.semAgua) {
          const ligarCanhao = irr.config.canhao === true;
          canhaoNoInicio = async () => {
            // Programação/agenda SEM canhão: ninguém está na tela para ver. Se ele ficou ligado de
            // uma irrigação anterior (status lendo 1), desliga para irrigar como foi agendado.
            // No Ligar manual nada muda: sem canhão pedido, o NexON não mexe nele.
            if (!ligarCanhao && !(origemSeq === 'programacao' && pts.cmd.canhao && pts.st.canhao && (await this.lerStatus(pts.st.canhao)) === 1)) return;
            const r = await this.aplicarCanhao(id, pts, ligarCanhao, user, cliente, cfg.sequencia.confirma_giro_s, ctl)
              .catch((x) => { this.logger.warn(`[pivo-seq] ${id} canhão: ${msgErro(x)}`); return 'nao_confirmou' as const; });
            const certo = r === 'ok' || r === 'ja';
            const msg = MSG_CANHAO[r](ligarCanhao, cfg.sequencia.confirma_giro_s);
            await passo('canhao', msg, certo ? true : r === 'nao_confirmou' ? false : null);
            if (!certo) await this.trilha(id, msg, (user as Autor | undefined)?.id?.trim() || null, origemSeq, 'WARN');
          };
        }
      }
      // Parada automática (voltas/tempo/ângulo): o PivoAutomacaoService desliga em parar_em.
      if (irr && irr.parada.tipo !== 'semParar') {
        // Reinício que herdou a parada em curso: vale o que faltava (não recomeça do zero).
        const ms = extra.restanteParadaMs !== undefined
          ? extra.restanteParadaMs
          : duracaoParadaMs(irr, await this.tempoVolta100(id), await this.anguloAtual(id));
        if (ms != null) {
          const pararEm = new Date(Date.now() + ms);
          await this.prisma.$executeRaw`UPDATE pivo_sequencias SET parar_em = ${pararEm} WHERE id = ${ctl.seqId}`;
          await passo('parada', `Parada automática prevista para ${pararEm.toLocaleString('pt-BR', { timeZone: FUSO_OPERACAO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`, true);
        } else {
          await passo('parada', 'Parada por ângulo sem leitura de ângulo do pivô — o servidor para quando o ângulo for lido', null);
        }
      }
      if (canhaoNoInicio && !ctl.cancelar) await canhaoNoInicio();
      await fim('concluida');
    } catch (e: any) {
      await passo('erro', msgErro(e), false).catch(() => undefined);
      const autorTrilha = (user as Autor | undefined)?.id?.trim() || null;
      // Desligar de irrigação PARADA que estourou (TON da bomba sem resposta): a parada por tempo
      // é a única proteção dela. A linha sai de cena para a irrigação seguir contando como em
      // curso (nova tentativa no próximo tick) e o aviso vai para a trilha.
      if (acao === 'desligar' && paraSemGiro) {
        await fim('cancelada', `Desligar não concluiu: ${msgErro(e)}`).catch(() => undefined);
        await this.bombaNaoDesligou(id, msgErro(e), autorTrilha, origemSeq);
        return;
      }
      // Reinício que falhou ANTES de qualquer comando chegar ao pivô: ele segue girando com a
      // irrigação anterior. A linha nova sai de cena ('cancelada') para a anterior voltar a
      // valer — com a parada automática e a pausa de ponta dela.
      if (reiniciar && faseReinicio !== 'depois' && !paradaEnviada) {
        await fim('cancelada', `Reinício não executou: ${msgErro(e)}`).catch(() => undefined);
        await this.trilha(id, `Reinício NÃO executou: ${msgErro(e)} — o pivô segue com a irrigação anterior`, autorTrilha, 'manual', 'ALTA');
        this.logger.warn(`[pivo-seq] ${id} reinício não executou: ${msgErro(e)}`);
        return;
      }
      // Reinício que falhou NO MEIO da parada (comando sem ack, bomba que não respondeu): o
      // pivô pode ter parado ou não. Tenta a parada de novo e confere o estado:
      //  - parado (status, ou comando aceito sem status dizendo que gira) → completa o
      //    desligamento (bomba) e a sequência falha com o pivô desligado;
      //  - girando ou sem como saber → NÃO mexe na bomba (não gira a seco) e a linha é
      //    cancelada: a irrigação anterior volta a valer, com a parada automática dela.
      if (reiniciar && faseReinicio === 'parando') {
        const ptsR = await this.pontos(id).catch(() => null);
        const cfgR = await this.lerConfig(id).catch(() => null);
        let aceita = false;
        if (ptsR && cfgR?.sequencia.comandos_mantidos && (ptsR.cmd.direita || ptsR.cmd.esquerda)) {
          aceita = true;
          for (const k of ['direita', 'esquerda'] as const) {
            if (ptsR.cmd[k]) await this.saidaMantida(id, ptsR.cmd[k], false, `Girar ${k} desligado`, user, cliente).catch(() => { aceita = false; });
          }
        } else if (ptsR?.cmd.desligar) {
          aceita = await this.cmd.acionarPonto(id, ptsR.cmd.desligar, user, false, undefined, cliente).then(() => true).catch(() => false);
        }
        const t = ptsR ? await this.estadoTrava(ptsR).catch(() => null) : null;
        const parado = t?.estado === 'parado' || (aceita && !!t && t.estado !== 'girando');
        if (parado) {
          await passo('pivo', 'Parada completada depois da falha', true).catch(() => undefined);
          if (cfgR?.bombeamento) await this.desligarBomba(id, cfgR.bombeamento, passo, user, cliente, !!ptsR?.cmd.desligar).catch(() => undefined);
          await fim('falhou', msgErro(e)).catch(() => undefined);
          await this.trilha(id, `Reinício falhou no meio da parada: ${msgErro(e)} — o pivô ficou desligado, confira a bomba no painel`, autorTrilha, 'manual', 'ALTA');
        } else {
          await fim('cancelada', `Reinício não executou: ${msgErro(e)}`).catch(() => undefined);
          await this.trilha(id, `Reinício NÃO executou: ${msgErro(e)} — parada não confirmada; vale a irrigação anterior. Confira o pivô e a bomba no painel`, autorTrilha, 'manual', 'ALTA');
        }
        this.logger.warn(`[pivo-seq] ${id} reinício falhou na parada (${parado ? 'parado' : 'sem confirmar'}): ${msgErro(e)}`);
        return;
      }
      // Giro não confirmado: o comando pode ter ido (retorno atrasado/perdido) e o pivô
      // estar girando sem a sequência saber — sem parada programada e, com a bomba
      // desligada abaixo, a seco. Volta ao estado conhecido: manda Desligar ao pivô.
      if (e instanceof FalhaGiro && acao !== 'desligar') {
        const ptsF = await this.pontos(id).catch(() => null);
        const mantF = await this.mantido(id).catch(() => false);
        if (ptsF && mantF && (ptsF.cmd.direita || ptsF.cmd.esquerda)) {
          for (const k of ['direita', 'esquerda'] as const) {
            if (ptsF.cmd[k]) await this.saidaMantida(id, ptsF.cmd[k], false, `Girar ${k} desligado`, user, cliente).catch(() => undefined);
          }
          await passo('pivo', 'Giro não confirmado — saídas de giro desligadas (estado seguro)', true).catch(() => undefined);
        } else if (ptsF?.cmd.desligar) {
          await this.cmd.acionarPonto(id, ptsF.cmd.desligar, user, false, undefined, cliente)
            .then(() => { desligarEnviado = true; return passo('pivo', 'Giro não confirmado — comando Desligar enviado ao pivô (estado seguro)', true); })
            .catch((x) => passo('pivo', `Giro não confirmado e o Desligar falhou: ${msgErro(x)}`, false))
            .catch(() => undefined);
        }
      }
      // Percentímetro já mandado nesta partida: desliga (a TON não fica ciclando o motor à toa).
      if (percEnviado && acao !== 'desligar') {
        const ptsP = await this.pontos(id).catch(() => null);
        if (ptsP) await this.percentimetro(id, ptsP, 'off', user, cliente).catch(() => undefined);
      }
      // falhou depois de ligar a bomba: não deixa bomba ligada à toa
      if ((e instanceof FalhaBomba || ((e instanceof FalhaGiro || e instanceof FalhaPartida) && e.liguei)) && acao !== 'desligar') {
        const cfg = await this.lerConfig(id).catch(() => null);
        if (cfg?.bombeamento) await this.desligarBomba(id, cfg.bombeamento, passo, user, cliente, desligarEnviado).catch(() => undefined);
      }
      await fim('falhou', msgErro(e)).catch(() => undefined);
      // Reinício que parou o pivô e não religou: fica na trilha (busca por "Reinício").
      if (reiniciar) await this.trilha(id, `Reinício não religou o pivô: ${msgErro(e)}`, autorTrilha, 'manual', 'ALTA');
      this.logger.warn(`[pivo-seq] ${id} ${acao} falhou: ${msgErro(e)}`);
    }
  }

  private async interrompida(passo: (e: string, m: string, ok: boolean | null) => Promise<void>, fim: (s: any, e?: string) => Promise<void>) {
    await passo('fim', 'Interrompida pelo Desligar', null);
    await fim('interrompida');
  }

  /**
   * Desliga a bomba se nenhum outro pivô da mesma bomba estiver girando.
   * Pontos: o Desligar do painel para o pivô e a bomba — se o deste pivô já foi
   * (`desligarEnviado`), só confirma; no conjugado, manda o Desligar do pivô dono.
   */
  private async desligarBomba(
    id: string, b: Bombeamento,
    passo: (e: string, m: string, ok: boolean | null) => Promise<void>,
    user?: Autor, cliente?: ClienteInfo, desligarEnviado = false,
  ) {
    // Válvula ON/OFF deste pivô: fecha DEPOIS da bomba (não fecha o caminho com a bomba empurrando);
    // com a bomba mantida para outro pivô do conjugado, fecha logo (a água segue para o outro).
    const pValvula = (await this.pontos(id)).cmd.valvula;
    try {
      await this._desligarBomba(id, b, passo, user, cliente, desligarEnviado);
    } finally {
      if (pValvula && (await this.saidaMantida(id, pValvula, false, 'Válvula OFF', user, cliente).catch(() => false)))
        await passo('valvula', 'Válvula fechada (OFF)', true);
    }
  }

  private async _desligarBomba(
    id: string, b: Bombeamento,
    passo: (e: string, m: string, ok: boolean | null) => Promise<void>,
    user?: Autor, cliente?: ClienteInfo, desligarEnviado = false,
  ) {
    const comp = await this.companheiros(id, b);
    const girando: string[] = [];
    for (const c of comp) {
      const s = await this.statusPivo(await this.pontos(c.id));
      // irrigando parado (só a bomba) também usa a água, mesmo sem girar
      if (s.direita === 1 || s.esquerda === 1 || (this.rodando.has(c.id)) || (await this.irrigacaoAtiva(c.id))?.irrigacao?.config?.semGiro) girando.push(c.nome);
    }
    if (girando.length) {
      await passo('bomba', `Bomba mantida ligada: ${girando.join(', ')} ainda usando`, true);
      return;
    }
    if (b.origem === 'pontos' && b.modo === 'mantido') {
      // Saídas mantidas: o Ligar (do dono, no conjugado) vai a baixo — não depende do ponto Desligar.
      await this.cmd.acionarBoDireto({ equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: 'desliga', rotulo: 'Ligar desligado (bomba)' }, user, cliente);
      await passo('bomba', 'Saída Ligar desligada (bomba)', true);
      if (b.bi_confirma) {
        const ok = await this.esperar(async () => (await this.bombaLigada(b)) === 0, b.confirma_s ?? 30, { cancelar: false });
        await passo('bomba', ok ? 'Bomba desligada (Ligado = 0)' : `Bomba não confirmou desligada em ${b.confirma_s ?? 30}s`, !!ok);
      }
      return;
    }
    if (b.origem === 'pontos') {
      const dono = b.dono_id ?? id;
      if (!(desligarEnviado && dono === id)) {
        const pd = (await this.pontos(dono)).cmd.desligar;
        if (!pd) {
          await passo('bomba', 'Sem o ponto Desligar ligado a uma BO — a bomba não foi desligada', false);
          return;
        }
        await this.cmd.acionarPonto(dono, pd, user, false, undefined, cliente);
        await passo('bomba', dono === id ? 'Comando Desligar enviado (desliga a bomba)' : 'Comando Desligar enviado ao pivô dono da bomba', true);
      }
      if (b.bi_confirma) {
        const ok = await this.esperar(async () => (await this.bombaLigada(b)) === 0, b.confirma_s ?? 30, { cancelar: false });
        await passo('bomba', ok ? 'Bomba desligada (Ligado = 0)' : `Bomba não confirmou desligada em ${b.confirma_s ?? 30}s`, !!ok);
      }
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
      const ok = await this.esperar(async () => (await this.bombaLigada(b)) === 0, b.confirma_s ?? 30, { cancelar: false });
      await passo('bomba', ok ? 'Bomba desligada (confirmado pela BI)' : `Bomba não confirmou desligada em ${b.confirma_s ?? 30}s`, !!ok);
    }
  }

  // ------------------------------------------------------------------ apoio
  /** Outros pivôs com a MESMA bomba (mesma TON + mesma BO de ligar). */
  private async companheiros(id: string, b: Bombeamento): Promise<Array<{ id: string; nome: string }>> {
    const out: Array<{ id: string; nome: string }> = [];
    for (const p of await this.pivosDaPlanta(id)) {
      const o = (await this.lerConfig(p.id)).bombeamento;
      if (o && o.ton_id === b.ton_id && Number(o.bo_liga) === Number(b.bo_liga)) out.push(p);
    }
    return out;
  }

  private async pontos(id: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; tipo: string; nome: string; ton_id: string | null; bi: number | null; inv: boolean | null }>>`
      SELECT TRIM(p.id) AS id, p.tipo, p.nome, TRIM(b.ton_id) AS ton_id, b.bi_numero AS bi, b.invertido AS inv
      FROM equipamento_pontos p
      LEFT JOIN ton_bi b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      WHERE p.equipamento_id = ${id}::bpchar AND p.deleted_at IS NULL AND p.ativo
      ORDER BY p.ordem, p.nome, b.updated_at DESC NULLS LAST`;   // ponto em 2 BIs (legado): vale o vínculo mais recente
    const cmd: Partial<Record<PapelComando, string>> = {};
    const st: Partial<Record<PapelStatus, { ton_id: string; bi: number; inv: boolean }>> = {};
    let modoTon: MapaBi | null = null;
    for (const r of rows) {
      const n = norm(r.nome);
      if (r.tipo === 'status' && PAPEL_MODO_TON.test(n)) {
        if (!modoTon && r.ton_id && r.bi) modoTon = { ton_id: r.ton_id, bi: r.bi, inv: !!r.inv };
        continue;
      }
      if (r.tipo === 'comando') {
        // ordem importa: "anti-horário" antes de "horário"
        for (const k of ['valvula', 'canhao', 'ligar', 'percentimetro', 'esquerda', 'direita', 'desligar'] as const) if (PAPEIS_COMANDO[k].test(n)) { if (!cmd[k]) cmd[k] = r.id; break; }
      } else if (r.tipo === 'status' && r.ton_id && r.bi) {
        for (const k of ['canhao', 'ligado', 'permissivo', 'pressao', 'erro', 'desligado', 'esquerda', 'direita'] as const) if (PAPEIS_STATUS[k].test(n)) { if (!st[k]) st[k] = { ton_id: r.ton_id, bi: r.bi, inv: !!r.inv }; break; }
      }
    }
    return { cmd, st, modoTon };
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

  /** Data da leitura das entradas de status do pivô: a mais antiga delas; null = alguma sem leitura ou nenhum ponto. */
  private async lidoEmPivo(pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }) {
    const datas: Array<Date | null> = [];
    for (const m of Object.values(pts.st)) {
      if (m) datas.push((await this.cmd.lerEntradaTon(m.ton_id, m.bi)).updated_at);
    }
    return leituraMaisAntiga(datas);
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
/** Partida interrompida antes de girar (sem pressão, percentímetro não aplicado). */
class FalhaPartida extends Error {
  constructor(msg: string, readonly liguei: boolean) { super(msg); }
}
class FalhaGiro extends Error {
  constructor(msg: string, readonly liguei: boolean) { super(msg); }
}
