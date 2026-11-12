import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClienteInfo, PrismaService, ScopedUser } from '@/core';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import { novoId26 } from '../../core/common/cliente-info';
import { capacidades, MSG_SOMENTE_LEITURA, papelCanonico } from '../../core/modules/auth/papeis';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import { colunaTrilhaAusente } from '../logs-mqtt/logs-mqtt-filtros';
import { CalibracaoAnguloDto } from './dto/pivos.dto';
import { PivoSequenciaService } from './pivo-sequencia.service';
import { comandoEnc, PivoTonService } from './pivo-ton.service';
import { anguloDoEncoder, brutoDoEncoder } from './pivo-posicao.util';
import { calibracaoAnterior, calibracaoVigente, LinhaCalibracao, tabelaCalibracaoExiste } from './pivo-calibracao.repo';
import {
  avaliarLeituras,
  avaliarPublicacoes,
  azimute,
  coordenadaValida,
  DISTANCIA_MAX_M,
  DISTANCIA_MIN_M,
  distanciaM,
  LEITURAS_CALIBRACAO,
  lerAckEncoder,
  Sentido,
  zeroDaCalibracao,
} from './pivo-calibracao.util';

type Autor = ScopedUser & { nome?: string };

/** A leitura do "Ler encoder" vale por este tempo para o "Salvar calibração". */
const LEITURA_VALE_MS = 10 * 60_000;

const TXT_TON: Array<[RegExp, string]> = [
  [/pivo_cmd_desconhecido|unknown/i, 'A TON deste pivô ainda não tem a leitura do encoder para calibração: regrave o firmware da placa'],
  [/pivo_sem_encoder/, 'A TON não tem encoder no RS485: confira o nó Encoder na Topologia e regrave o firmware'],
  [/pivo_ligado/, 'A TON está com o pivô ligado: a calibração só é feita com o pivô parado'],
  [/pivo_enc_invalido/, 'A TON recusou os valores da calibração'],
  [/already_seen/, 'a resposta do comando se perdeu no rádio (a placa devolveu só "already_seen")'],
  [/lora_no_ack/, 'A TON não respondeu pelo rádio LoRa'],
  [/nao respondeu|timeout/i, 'A TON não respondeu (sem comunicação)'],
];

const sentidoLegivel = (s: Sentido) => (s === 1 ? 'Horário' : 'Anti-horário');
const grausTxt = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°`;

/**
 * Calibração do ângulo do pivô (NEXON-103).
 *
 * A calibração associa uma leitura do encoder ao azimute real do braço (centro → ponta,
 * medido em campo). Aqui ela é validada, enviada para a TON — que confirma a gravação na
 * memória da placa e passa a calcular o ângulo sozinha, sem internet — e só então gravada
 * em `calibracao_angulo` (uma linha por calibração; a anterior é desativada, nunca apagada).
 *
 * Quem edita: Admin e analistas (config técnica — o "técnico" da spec). Proprietário e
 * operador só leem. Toda gravação vai para a trilha do pivô e para a auditoria.
 */
@Injectable()
export class PivoCalibracaoService {
  private readonly logger = new Logger('PivoCalibracao');
  /** Última leitura VÁLIDA do "Ler encoder" por pivô (o Salvar só aceita o valor que a TON leu). */
  private readonly leituras = new Map<string, { valor: number; leituras: number[]; em: number; usuarioId: string | null }>();
  /** Pivôs com uma gravação (salvar/restaurar) em andamento: a segunda espera a primeira terminar. */
  private readonly gravando = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: PivoSequenciaService,
    private readonly ton: PivoTonService,
    private readonly cmd: EquipamentosCmdService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  // ------------------------------------------------------------------ leitura
  async ver(pivoId: string, user?: Autor) {
    const estado = await this.seq.estado(pivoId, user);   // confere escopo e que é pivô
    const id = String(pivoId).trim();
    const pos = estado.posicao;
    const enc = pos.encoder;
    const encNome = enc
      ? (await this.prisma.equipamentos.findFirst({ where: { id: enc.equipamento_id }, select: { nome: true } }))?.nome?.trim() ?? null
      : null;
    const lida = this.leituraValida(id);
    return {
      pode_editar: this.podeEditar(user),
      encoder: enc ? { equipamento_id: enc.equipamento_id, nome: encNome, resolucao: enc.resolucao } : null,
      vigente: this.paraTela(await calibracaoVigente(this.prisma, id)),
      anterior: this.paraTela(await calibracaoAnterior(this.prisma, id)),
      precondicoes: this.precondicoes(estado),
      leitura: { bruto: pos.bruto, lido_em: pos.lido_em, angulo: pos.angulo, motivo: pos.motivo },
      ultima_leitura_valida: lida ? { valor: lida.valor, leituras: lida.leituras, em: new Date(lida.em) } : null,
      distancia_min_m: DISTANCIA_MIN_M,
      distancia_max_m: DISTANCIA_MAX_M,
      leituras_exigidas: LEITURAS_CALIBRACAO,
    };
  }

  // ------------------------------------------------------------------ ler encoder
  /**
   * "Ler encoder": a TON faz 5 leituras Modbus seguidas (`pivo encler`). Só vale se vieram
   * todas, sem erro, iguais ou variando no máximo ±1.
   */
  async lerEncoder(pivoId: string, user?: Autor, cliente?: ClienteInfo) {
    this.exigirEdicao(user);
    const estado = await this.seq.estado(pivoId, user);
    const id = String(pivoId).trim();
    const enc = this.exigirEncoder(estado);
    const tonId = await this.tonDoEncoder(id, user, cliente);
    let ack: ReturnType<typeof lerAckEncoder> = null;
    let falha: unknown = null;
    try {
      const msg = (await this.cmd.comandoTon(
        { equipamentoId: id, tonId, cmd: 'pivo encler', rotulo: 'Leitura do encoder para calibração', ackOk: /^pivo_el/ }, user, cliente,
      )).msg;
      ack = lerAckEncoder(msg);
      if (!ack) falha = new Error(msg);
    } catch (e) {
      falha = e;
    }
    if (!ack) {
      // A TON recusou de propósito (pivô ligado, firmware sem encoder): não há o que contornar.
      const bruto = String((falha as any)?.response?.message ?? (falha as Error)?.message ?? falha);
      if (/pivo_ligado|pivo_sem_encoder/.test(bruto)) throw this.erroDaTon(falha, 'A TON não leu o encoder');
      // A resposta do comando não chegou (satélite LoRa: o ack com as leituras colide com o reenvio
      // do gateway e volta só "already_seen"; firmware antigo; rádio mudo). O encoder continua
      // sendo publicado sozinho a cada minuto: a leitura sai dessas publicações.
      return this.lerPelaPublicacao(id, enc, bruto, user, cliente);
    }
    const r = avaliarLeituras(ack.leituras, enc.resolucao, ack.erros);
    if (r.valida && r.valor != null) {
      this.leituras.set(id, { valor: r.valor, leituras: r.leituras, em: Date.now(), usuarioId: user?.id?.trim() ?? null });
    } else {
      this.leituras.delete(id);
    }
    await this.trilha(id, r.valida
      ? `Encoder lido para calibração: ${r.valor} (${r.leituras.join(', ')})`
      : `Leitura do encoder para calibração recusada: ${r.motivo}${r.leituras.length ? ` (${r.leituras.join(', ')})` : ''}`,
    user, cliente, r.valida ? 'INFO' : 'WARN');
    return { valida: r.valida, valor: r.valor, leituras: r.leituras, motivo: r.motivo, lido_em: new Date(), origem: 'comando' as const };
  }

  /** Leitura do encoder pelas publicações automáticas da TON (reserva do `pivo encler` sem resposta). */
  private async lerPelaPublicacao(
    id: string, enc: { equipamento_id: string; resolucao: number | null }, falhaDoComando: string, user?: Autor, cliente?: ClienteInfo,
  ) {
    const rows = await this.prisma.$queryRaw<Array<{ dados: any; ts: Date }>>`
      SELECT dados, timestamp_dados AS ts FROM equipamentos_dados
      WHERE equipamento_id = ${enc.equipamento_id}::bpchar ORDER BY timestamp_dados DESC LIMIT 6`.catch(() => []);
    const pubs = rows
      .map((r) => ({ valor: brutoDoEncoder(r.dados), amostras: Number(r.dados?.samples), em: r.ts }))
      .filter((p): p is { valor: number; amostras: number; em: Date } => p.valor != null);
    const r = avaliarPublicacoes(pubs, enc.resolucao);
    const porque = TXT_TON.find(([re]) => re.test(falhaDoComando))?.[1] ?? `a TON respondeu "${falhaDoComando.slice(0, 80)}" sem as leituras`;
    if (!r.valida || r.valor == null) {
      this.leituras.delete(id);
      await this.trilha(id, `Leitura do encoder para calibração falhou: ${porque}; pela publicação automática também não: ${r.motivo}`, user, cliente, 'WARN');
      throw new BadGatewayException(`A TON não devolveu as leituras do encoder (${porque}) e pela publicação automática também não deu: ${r.motivo}`);
    }
    this.leituras.set(id, { valor: r.valor, leituras: r.leituras, em: Date.now(), usuarioId: user?.id?.trim() ?? null });
    await this.trilha(id, `Encoder lido para calibração pela publicação automática da TON: ${r.valor} (${r.leituras.join(', ')}) — o comando não devolveu as leituras (${porque})`, user, cliente);
    return { valida: true, valor: r.valor, leituras: r.leituras, motivo: null, lido_em: new Date(), origem: 'publicacao' as const };
  }

  // ------------------------------------------------------------------ salvar
  async salvar(pivoId: string, dto: CalibracaoAnguloDto, user?: Autor, cliente?: ClienteInfo) {
    this.exigirEdicao(user);
    const estado = await this.seq.estado(pivoId, user);
    const id = String(pivoId).trim();
    return this.umaPorVez(id, () => this.salvarTravado(id, estado, dto, user, cliente));
  }

  private async salvarTravado(id: string, estado: Awaited<ReturnType<PivoSequenciaService['estado']>>, dto: CalibracaoAnguloDto, user?: Autor, cliente?: ClienteInfo) {
    await this.exigirTabela();
    const enc = this.exigirEncoder(estado);
    const resolucao = enc.resolucao as number;

    const centro = { lat: Number(dto.centro_lat), lon: Number(dto.centro_lon) };
    const ponta = { lat: Number(dto.ponta_lat), lon: Number(dto.ponta_lon) };
    if (!coordenadaValida(centro) || !coordenadaValida(ponta)) throw new BadRequestException('Informe a posição do centro e da ponta em graus decimais');
    const dist = distanciaM(centro, ponta);
    if (!(dist > DISTANCIA_MIN_M)) {
      throw new BadRequestException(`Pontos muito próximos: centro e ponta estão a ${Math.floor(dist)} m (mínimo ${DISTANCIA_MIN_M} m)`);
    }
    if (dist > DISTANCIA_MAX_M) {
      throw new BadRequestException(`Pontos muito distantes: centro e ponta estão a ${Math.round(dist).toLocaleString('pt-BR')} m (máximo ${DISTANCIA_MAX_M.toLocaleString('pt-BR')} m) — confira o sinal de menos e se latitude e longitude não estão trocadas`);
    }
    const sentido: Sentido = Number(dto.sentido) === -1 ? -1 : 1;

    // Leitura válida: só o valor que a TON acabou de ler (5 leituras) — nada digitado.
    const lida = this.leituraValida(id);
    if (!lida) throw new ConflictException('Leia o encoder antes de salvar (a leitura vale por 10 minutos)');
    if (Number(dto.bruto_cal) !== lida.valor) throw new ConflictException(`A leitura do encoder mudou (${lida.valor}): leia de novo e confira antes de salvar`);

    const pre = this.precondicoes(estado);
    if (pre.pendencias.length) throw new ConflictException(pre.pendencias[0]);

    const az = azimute(centro, ponta);
    const cal = { az_cal: az, bruto_cal: lida.valor, sentido };
    const { zero, invertido } = zeroDaCalibracao(cal, resolucao);
    const anterior = await calibracaoVigente(this.prisma, id);
    const tonId = await this.tonDoEncoder(id, user, cliente);

    // 1) TON primeiro: sem a confirmação da placa nada é gravado. Daqui em diante a placa pode
    // ter mudado (até com o ack perdido): a próxima partida reconfere a configuração inteira.
    this.ton.esquecerConfig(tonId);
    await this.gravarNaTon(id, tonId, { resolucao, invertido, zero }, user, cliente);

    // 2) Banco: desativa a anterior, grava a nova e espelha zero + sentido na Configuração.
    const novoId = novoId26();
    const usuarioId = user?.id?.trim() ?? null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE calibracao_angulo SET ativa = false, desativada_em = now(), desativada_por = ${usuarioId}, motivo_desativacao = 'Nova calibração'
          WHERE equipamento_id = ${id}::bpchar AND ativa`;
        await tx.$executeRaw`
          INSERT INTO calibracao_angulo
            (id, equipamento_id, bruto_cal, sentido, centro_lat, centro_lon, ponta_lat, ponta_lon, az_cal,
             resolucao, zero, encoder_equipamento_id, leituras, origem, usuario_id, criado_em, ativa)
          VALUES
            (${novoId}, ${id}, ${lida.valor}, ${sentido}, ${centro.lat}, ${centro.lon}, ${ponta.lat}, ${ponta.lon}, ${az},
             ${resolucao}, ${zero}, ${enc.equipamento_id}, ${JSON.stringify(lida.leituras)}::jsonb, 'calibracao', ${usuarioId}, now(), true)`;
        await this.espelharNaConfig(tx, id, zero, invertido, usuarioId);
      });
    } catch (e) {
      // A placa já está com a calibração nova e o banco não: volta a placa para o que valia
      // (sem calibração anterior, "sem encoder" — como estava).
      await this.desfazerNaTon(id, tonId, anterior, user, cliente);
      throw e;
    }
    this.leituras.delete(id);
    await this.resolverSentidoInvertido(id, 'Recalibrado');

    const resumo = `azimute ${grausTxt(az)}, leitura ${lida.valor}, sentido ${sentidoLegivel(sentido)}`;
    await this.trilha(id, `Calibração do ângulo gravada na TON: ${resumo}${anterior ? ` (anterior: azimute ${grausTxt(anterior.az_cal)}, leitura ${anterior.bruto_cal}, ${sentidoLegivel(anterior.sentido)})` : ''}`, user, cliente);
    await this.auditar('pivo_calibracao', id, `Calibração do ângulo do pivô: ${resumo}`, user, cliente, {
      calibracao_id: novoId, ton_id: tonId, encoder_equipamento_id: enc.equipamento_id, resolucao,
      depois: { az_cal: az, bruto_cal: lida.valor, sentido, zero, centro, ponta, distancia_m: Math.round(dist), leituras: lida.leituras },
      antes: anterior ? this.paraTela(anterior) : null,
    });
    return this.ver(id, user);
  }

  // ------------------------------------------------------------------ restaurar
  /** "Restaurar calibração anterior": reativa a última inativa, na TON e no NexON. */
  async restaurar(pivoId: string, user?: Autor, cliente?: ClienteInfo) {
    this.exigirEdicao(user);
    const estado = await this.seq.estado(pivoId, user);
    const id = String(pivoId).trim();
    return this.umaPorVez(id, () => this.restaurarTravado(id, estado, user, cliente));
  }

  private async restaurarTravado(id: string, estado: Awaited<ReturnType<PivoSequenciaService['estado']>>, user?: Autor, cliente?: ClienteInfo) {
    await this.exigirTabela();
    const enc = this.exigirEncoder(estado);
    const anterior = await calibracaoAnterior(this.prisma, id);
    if (!anterior) throw new NotFoundException('Este pivô não tem calibração anterior para restaurar');
    if (anterior.resolucao !== enc.resolucao || (anterior.encoder_equipamento_id && anterior.encoder_equipamento_id !== enc.equipamento_id)) {
      throw new ConflictException('A calibração anterior é de outro encoder ou de outra resolução: faça uma calibração nova');
    }
    const pre = this.precondicoes(estado);
    if (pre.pendencias.length) throw new ConflictException(pre.pendencias[0]);

    const atual = await calibracaoVigente(this.prisma, id);
    const { zero, invertido } = zeroDaCalibracao(anterior, anterior.resolucao);
    const tonId = await this.tonDoEncoder(id, user, cliente);
    this.ton.esquecerConfig(tonId);
    await this.gravarNaTon(id, tonId, { resolucao: anterior.resolucao, invertido, zero }, user, cliente);

    const usuarioId = user?.id?.trim() ?? null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE calibracao_angulo SET ativa = false, desativada_em = now(), desativada_por = ${usuarioId}, motivo_desativacao = 'Calibração anterior restaurada'
          WHERE equipamento_id = ${id}::bpchar AND ativa`;
        await tx.$executeRaw`
          UPDATE calibracao_angulo SET ativa = true, desativada_em = NULL, desativada_por = NULL, motivo_desativacao = NULL, origem = 'restauracao'
          WHERE id = ${anterior.id}::bpchar`;
        await this.espelharNaConfig(tx, id, zero, invertido, usuarioId);
      });
    } catch (e) {
      await this.desfazerNaTon(id, tonId, atual, user, cliente);
      throw e;
    }
    this.leituras.delete(id);
    await this.resolverSentidoInvertido(id, 'Calibração anterior restaurada');

    const resumo = `azimute ${grausTxt(anterior.az_cal)}, leitura ${anterior.bruto_cal}, sentido ${sentidoLegivel(anterior.sentido)}`;
    await this.trilha(id, `Calibração anterior restaurada na TON: ${resumo}${atual ? ` (substitui: azimute ${grausTxt(atual.az_cal)}, leitura ${atual.bruto_cal}, ${sentidoLegivel(atual.sentido)})` : ''}`, user, cliente);
    await this.auditar('pivo_calibracao_restaurada', id, `Calibração anterior do pivô restaurada: ${resumo}`, user, cliente, {
      calibracao_id: anterior.id, ton_id: tonId, resolucao: anterior.resolucao,
      depois: this.paraTela(anterior), antes: atual ? this.paraTela(atual) : null,
    });
    return this.ver(id, user);
  }

  // ------------------------------------------------------------------ internos
  private podeEditar(user?: Autor): boolean {
    return !user || capacidades(papelCanonico(user.role)).configTecnica;
  }

  private exigirEdicao(user?: Autor) {
    if (!this.podeEditar(user)) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
  }

  /** Sem a tabela não há onde gravar: avisa ANTES de mexer na placa. */
  private async exigirTabela() {
    if (!(await tabelaCalibracaoExiste(this.prisma).catch(() => false))) {
      throw new NotFoundException('Calibração indisponível neste servidor (SQL 2026-11-11c não aplicado)');
    }
  }

  /** Salvar e restaurar do mesmo pivô, um de cada vez (duplo clique enquanto a TON responde). */
  private async umaPorVez<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.gravando.has(id)) throw new ConflictException('Já há uma gravação da calibração em andamento neste pivô: aguarde');
    this.gravando.add(id);
    try {
      return await fn();
    } finally {
      this.gravando.delete(id);
    }
  }

  /**
   * O banco recusou depois de a placa aceitar: devolve a placa ao que o banco diz — a calibração
   * que continua vigente, ou "sem encoder" (`pivo enc 0 0 0`) quando não havia nenhuma.
   */
  private async desfazerNaTon(id: string, tonId: string, vigente: LinhaCalibracao | null, user?: Autor, cliente?: ClienteInfo) {
    const cmd = vigente ? comandoEnc({ resolucao: vigente.resolucao, ...zeroDaCalibracao(vigente, vigente.resolucao) }) : 'pivo enc 0 0 0';
    await this.cmd.comandoTon({ equipamentoId: id, tonId, cmd, rotulo: 'Calibração do ângulo desfeita na TON (o NexON não gravou)', ackOk: /^pivo_enc_ok$/ }, user, cliente)
      .catch((r) => this.logger.error(`[calibracao] ${id}: banco falhou e a TON não voltou ao que valia (${cmd}): ${r?.message ?? r}`));
  }

  private exigirEncoder(estado: Awaited<ReturnType<PivoSequenciaService['estado']>>) {
    const enc = estado.posicao.encoder;
    if (!enc || !enc.resolucao) {
      throw new BadRequestException('Pivô sem encoder: escolha o encoder e a resolução em Configuração → Posição do pivô');
    }
    return enc;
  }

  private leituraValida(id: string) {
    const l = this.leituras.get(id);
    if (!l) return null;
    if (Date.now() - l.em > LEITURA_VALE_MS) { this.leituras.delete(id); return null; }
    return l;
  }

  /**
   * Pré-condições da seção 3.2: pivô parado e chave seletora em modo TON. `pendencias`
   * vazia = pode salvar; cada texto é o motivo que a tela mostra ao lado do botão.
   */
  precondicoes(estado: Awaited<ReturnType<PivoSequenciaService['estado']>>) {
    const st = estado.pivo.status;
    const ton = estado.pivo.ton_local;
    const girando = st.direita === 1 || st.esquerda === 1;
    const executando = estado.sequencia?.status === 'executando';
    const semLeitura = st.direita === null && st.esquerda === null && !ton;
    const parado: boolean | null = girando || (!!ton && ton.e !== 0) || executando ? false : semLeitura ? null : true;
    const modoTon: boolean | null = !estado.pivo.tem_modo_ton ? true : estado.pivo.modo_ton === 1 ? true : estado.pivo.modo_ton === 0 ? false : null;
    const pendencias: string[] = [];
    if (parado === false) pendencias.push('Pivô em movimento: a calibração só é feita com o pivô parado');
    if (parado === null) pendencias.push('Sem leitura do estado do pivô: não dá para saber se ele está parado');
    if (modoTon === false) pendencias.push('Chave seletora em modo CLP: passe para o modo TON');
    if (modoTon === null) pendencias.push('Sem leitura da chave seletora (modo TON)');
    return { parado, modo_ton: modoTon, tem_modo_ton: estado.pivo.tem_modo_ton, pendencias };
  }

  /** TON que executa o pivô, com o encoder no RS485 dela (é quem lê e quem guarda a calibração). */
  private async tonDoEncoder(id: string, user?: Autor, cliente?: ClienteInfo): Promise<string> {
    const alvo = await this.ton.alvo(id, user, cliente);
    if (!alvo) throw new ConflictException(await this.porQueSemTon(id));
    if (!(await this.ton.encoderNaTon(id, alvo.tonId, false))) throw new ConflictException(await this.porQueEncoderFora(id, alvo.tonId));
    return alvo.tonId;
  }

  /**
   * O pivô não tem TON que execute a calibração: diz QUAL é o problema (comandos sem BO, em mais
   * de uma TON, TON sem tópico, TON que não respondeu) em vez de uma frase genérica.
   */
  private async porQueSemTon(id: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ nome: string; ton_id: string | null; ton_nome: string | null; topico: string | null }>>`
      SELECT p.nome, TRIM(b.ton_id) AS ton_id, TRIM(t.nome) AS ton_nome, NULLIF(TRIM(t.topico_mqtt), '') AS topico
      FROM equipamento_pontos p
      LEFT JOIN ton_bo b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      LEFT JOIN equipamentos t ON t.id = b.ton_id
      WHERE p.equipamento_id = ${id}::bpchar AND p.deleted_at IS NULL AND p.ativo AND p.tipo = 'comando'`.catch(() => []);
    const sem = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const ligados = rows.filter((r) => r.ton_id);
    const tem = (re: RegExp) => ligados.some((r) => re.test(sem(r.nome)));
    if (!tem(/direit|horario/) || !tem(/esquerd/) || !tem(/percent/)) {
      return 'Os comandos de giro (direita e esquerda) e o percentímetro do pivô não estão todos ligados a uma saída da TON: confira em Topologia → TON → Configurar BOs';
    }
    const tons = new Map(ligados.map((r) => [r.ton_id as string, r]));
    if (tons.size > 1) {
      return `Os comandos do pivô estão em mais de uma TON (${[...tons.values()].map((t) => t.ton_nome ?? 'TON').join(', ')}): a calibração exige todos na mesma TON`;
    }
    const ton = [...tons.values()][0];
    const nome = ton.ton_nome ?? 'TON';
    if (!ton.topico) {
      return `A TON "${nome}" do pivô está sem Tópico Base no cadastro: sem ele o NexON não fala com a placa. Confira a TON na Topologia e salve o diagrama`;
    }
    const motivo = this.ton.motivoSemSuporte(ton.ton_id as string);
    return `A TON "${nome}" do pivô não respondeu ao NexON${motivo ? ` (${motivo.slice(0, 160)})` : ''}: confira se está ligada e com o firmware do pivô gravado`;
  }

  /** O encoder escolhido não é lido pela TON do pivô (tópico dele fora do tópico da TON). */
  private async porQueEncoderFora(id: string, tonId: string): Promise<string> {
    const r = await this.prisma.$queryRaw<Array<{ ton_nome: string | null; enc_nome: string | null }>>`
      SELECT (SELECT TRIM(nome) FROM equipamentos WHERE id = ${tonId}::bpchar) AS ton_nome,
             (SELECT TRIM(e.nome) FROM pivo_config c JOIN equipamentos e ON e.id = (c.parametros->>'encoder_equipamento_id')::bpchar
               WHERE c.equipamento_id = ${id}::bpchar) AS enc_nome`.catch(() => []);
    const ton = r[0]?.ton_nome ?? 'TON', enc = r[0]?.enc_nome ?? 'escolhido';
    return `O encoder "${enc}" não está no RS485 da TON "${ton}" do pivô (é de outra TON ou de um diagrama antigo): ligue o nó Encoder à TON do pivô na Topologia, salve e escolha esse encoder na Configuração`;
  }

  private async gravarNaTon(id: string, tonId: string, enc: { resolucao: number; invertido: boolean; zero: number }, user?: Autor, cliente?: ClienteInfo) {
    try {
      await this.cmd.comandoTon(
        { equipamentoId: id, tonId, cmd: comandoEnc(enc), rotulo: 'Calibração do ângulo do pivô na TON', ackOk: /^pivo_enc_ok$/ }, user, cliente,
      );
    } catch (e) {
      throw this.erroDaTon(e, 'A TON não confirmou a gravação da calibração');
    }
  }

  private erroDaTon(e: unknown, prefixo: string) {
    const bruto = String((e as any)?.response?.message ?? (e as Error)?.message ?? e);
    const txt = TXT_TON.find(([re]) => re.test(bruto))?.[1];
    return new BadGatewayException(`${prefixo}: ${txt ?? bruto}`);
  }

  /** Zero e sentido da calibração na Configuração do pivô — é o que a tela e a parada por ângulo usam. */
  private async espelharNaConfig(tx: { $executeRaw: PrismaService['$executeRaw'] }, id: string, zero: number, invertido: boolean, usuarioId: string | null) {
    const patch = JSON.stringify({ correcao_angulo_zero: zero, encoder_invertido: invertido });
    await tx.$executeRaw`
      UPDATE pivo_config SET parametros = COALESCE(parametros, '{}'::jsonb) || ${patch}::jsonb, updated_at = now(), updated_by = ${usuarioId}
      WHERE equipamento_id = ${id}::bpchar`;
  }

  private paraTela(c: LinhaCalibracao | null) {
    if (!c) return null;
    return {
      id: c.id, bruto_cal: c.bruto_cal, sentido: c.sentido, az_cal: c.az_cal,
      centro_lat: c.centro_lat, centro_lon: c.centro_lon, ponta_lat: c.ponta_lat, ponta_lon: c.ponta_lon,
      resolucao: c.resolucao, zero: c.zero, origem: c.origem, ativa: c.ativa,
      usuario_id: c.usuario_id, usuario_nome: c.usuario_nome, criado_em: c.criado_em, desativada_em: c.desativada_em,
      // O que a calibração dá para a leitura de referência (confere com o que a TON calcula)
      angulo_na_leitura: anguloDoEncoder(c.bruto_cal, { resolucao: c.resolucao, invertido: c.sentido === -1, zero: c.zero })?.angulo ?? null,
    };
  }

  /** Alarme "Sentido invertido — recalibrar" aberto deste pivô: recalibrou, resolve. */
  private async resolverSentidoInvertido(id: string, motivo: string) {
    try {
      await this.prisma.$executeRaw`
        UPDATE logs_mqtt SET resolvido_em = now(),
          dados_snapshot = COALESCE(dados_snapshot, '{}'::jsonb) || ${JSON.stringify({ normalizado_em: new Date().toISOString(), normalizado_por: motivo })}::jsonb
        WHERE tipo = 'alerta' AND resolvido_em IS NULL AND equipamento_id = ${id}::bpchar
          AND dados_snapshot->>'kind' = 'pivo_angulo' AND dados_snapshot->>'codigo' = 'sentido_invertido'`;
    } catch (e) {
      if (!colunaTrilhaAusente(e)) this.logger.warn(`[calibracao] ${id}: alarme de sentido não resolvido: ${(e as Error).message}`);
    }
  }

  /** Trilha do pivô (logs_mqtt tipo 'comando', comando_semantico 'pivo.calibracao'). Nunca lança. */
  private async trilha(id: string, mensagem: string, user?: Autor, cliente?: ClienteInfo, severidade = 'INFO') {
    try {
      const log = await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: id, severidade, status: 'gravado',
          mensagem: mensagem.slice(0, 500), usuario_id: user?.id?.trim() || null, comando_semantico: 'pivo.calibracao',
        },
      });
      if (cliente?.dispositivo && log?.id != null) {
        await this.prisma.$executeRaw`UPDATE logs_mqtt SET dispositivo = ${cliente.dispositivo} WHERE id = ${log.id}::bpchar`.catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(`[calibracao] trilha de ${id}: ${(e as Error)?.message}`);
    }
  }

  /** Auditoria (auditoria_acessos): quem calibrou, em que pivô, antes → depois. Nunca lança. */
  private async auditar(
    acao: 'pivo_calibracao' | 'pivo_calibracao_restaurada', id: string, mensagem: string,
    user: Autor | undefined, cliente: ClienteInfo | undefined, detalhes: Record<string, unknown>,
  ) {
    try {
      const ctx = await this.prisma.$queryRaw<Array<{ nome: string; unidade_id: string | null; unidade_nome: string | null; planta_id: string | null; planta_nome: string | null }>>`
        SELECT e.nome, TRIM(un.id) AS unidade_id, un.nome AS unidade_nome, TRIM(pl.id) AS planta_id, pl.nome AS planta_nome
        FROM equipamentos e
        LEFT JOIN equipamentos pai ON pai.id = e.equipamento_pai_id
        LEFT JOIN unidades un ON un.id = COALESCE(e.unidade_id, pai.unidade_id)
        LEFT JOIN plantas pl ON pl.id = un.planta_id
        WHERE e.id = ${id}::bpchar LIMIT 1`.catch(() => []);
      const c = ctx[0];
      const autor = user?.id
        ? await this.prisma.usuarios.findFirst({ where: { id: user.id.trim() }, select: { nome: true } }).catch(() => null)
        : null;
      const nome = c?.nome?.trim() ?? id;
      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        alvoUsuarioId: null,
        acao,
        mensagem: `${mensagem} — ${nome}${c?.unidade_nome ? ` (${c.unidade_nome.trim()})` : ''}`,
        plantaIds: c?.planta_id ? [c.planta_id] : [],
        unidadeIds: c?.unidade_id ? [c.unidade_id] : [],
        dispositivo: cliente?.dispositivo ?? null,
        objetoTipo: 'equipamento',
        objetoId: id,
        resultado: 'ok',
        autorNome: autor?.nome?.trim() ?? user?.nome ?? null,
        rota: `/pivos/${id}/calibracao`,
        detalhes: {
          usuario: user ? { id: user.id?.trim() ?? null, nome: autor?.nome?.trim() ?? null, papel: papelCanonico(user.role) } : null,
          pivo: { id, nome, unidade: c?.unidade_nome?.trim() ?? null, planta: c?.planta_nome?.trim() ?? null },
          ...detalhes,
        },
      });
    } catch (e) {
      this.logger.warn(`[calibracao] auditoria de ${id}: ${(e as Error)?.message}`);
    }
  }
}
