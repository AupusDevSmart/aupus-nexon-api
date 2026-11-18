import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/core';
import { emSegundos } from '../../shared/util/em-segundos';
import { CORRENTE_MAX_PADRAO_A, Falha } from './carregador-ocpp.regras';

export interface EstacaoCadastro {
  id: string;
  chargePointId: string;
  equipamentoId: string;
  plantaId: string | null;
  conector: number;
  conectado: boolean;
  status: string | null;
  errorCode: string | null;
  vendorErrorCode: string | null;
  info: string | null;
  statusEm: Date | null;
  falhaDesde: Date | null;
  perfis: string[];
  disponivel: boolean;
  ultimaConexao: Date | null;
  ultimaDesconexao: Date | null;
  ultimoHeartbeat: Date | null;
  ultimoBoot: Date | null;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  ip: string | null;
  chaveGeradaEm: Date | null;
  temChave: boolean;
  leitura: Record<string, any> | null;
  leituraEm: Date | null;
}

export interface ConfigCarregador {
  tarifaKwh: number | null;
  potenciaKw: number | null;
  limiteTempoMin: number | null;
  limiteEnergiaKwh: number | null;
  limiteCorrenteA: number | null;
  correnteMaxA: number;
  correnteSuportada: boolean | null;
  inicioAutomatico: boolean;
  ultimoSoc: number | null;
}

export interface SessaoCarregador {
  id: string;
  equipamentoId: string;
  plantaId: string | null;
  moradorId: string | null;
  moradorNome: string | null;
  inicio: Date;
  kwhInicio: number | null;
  kwhTotal: number | null;
  status: 'ativa' | 'encerrada';
  transactionId: number | null;
  idTag: string | null;
  limiteTempoMin: number | null;
  limiteEnergiaKwh: number | null;
  motivoFim: string | null;
  paradaPedidaEm: Date | null;
  liberadoPor: string;
}

export interface MoradorTag { id: string; nome: string; ativo: boolean; validade: string | null }
export interface NomeId { id: string; nome: string }
export interface ContextoCarregador {
  id: string;
  nome: string;
  unidade: NomeId | null;
  planta: NomeId | null;
  /** O equipamento é comandado pela TON (MQTT ligado com tópico): não convive com o OCPP. */
  mqtt: boolean;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const t = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v).trim());

/**
 * Banco da ponte OCPP ↔ carregador do condomínio (`carregador_config`, `carregador_sessoes`,
 * `ocpp_charge_points`, `equipamentos_dados`, `logs_mqtt`). SQL fora do serviço para os
 * testes trocarem por memória (testing/carregador-ocpp-repositorio.memoria.ts).
 *
 * O banco roda em UTC e as colunas são `timestamp` sem fuso: tudo aqui é UTC.
 */
@Injectable()
export class CarregadorOcppRepositorio {
  private readonly logger = new Logger(CarregadorOcppRepositorio.name);

  constructor(private readonly prisma: PrismaService) {}

  private novoId(): string {
    return randomBytes(13).toString('hex');
  }

  // ---- estação ----------------------------------------------------------------
  private estacaoDe(r: any): EstacaoCadastro {
    return {
      id: r.id, chargePointId: r.charge_point_id, equipamentoId: r.equipamento_id, plantaId: t(r.planta_id),
      conector: Number(r.connector_id) || 1, conectado: !!r.conectado, status: r.status ?? null,
      errorCode: r.error_code ?? null, vendorErrorCode: r.vendor_error_code ?? null, info: r.info ?? null,
      statusEm: r.status_em ?? null, falhaDesde: r.falha_desde ?? null,
      perfis: String(r.perfis ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      disponivel: r.disponivel !== false,
      ultimaConexao: r.ultima_conexao ?? null, ultimaDesconexao: r.ultima_desconexao ?? null,
      ultimoHeartbeat: r.ultimo_heartbeat ?? null, ultimoBoot: r.ultimo_boot ?? null,
      vendor: r.vendor ?? null, model: r.model ?? null, serial: r.serial_number ?? null, firmware: r.firmware_version ?? null,
      ip: r.ip ?? null, chaveGeradaEm: r.chave_gerada_em ?? null, temChave: !!r.tem_chave,
      leitura: r.leitura ?? null, leituraEm: r.leitura_em ?? null,
    };
  }

  /** Estação OCPP ligada ao carregador (equipamento), ou null: aí o carregador é o da TON. */
  async estacaoDoEquipamento(equipamentoId: string): Promise<EstacaoCadastro | null> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, charge_point_id, TRIM(equipamento_id) AS equipamento_id, TRIM(planta_id) AS planta_id,
             connector_id, conectado, status, error_code, vendor_error_code, info, status_em, falha_desde, perfis, disponivel,
             ultima_conexao, ultima_desconexao, ultimo_heartbeat, ultimo_boot, vendor, model, serial_number, firmware_version,
             ip, chave_gerada_em, (chave_hash IS NOT NULL) AS tem_chave, leitura, leitura_em
      FROM ocpp_charge_points
      WHERE equipamento_id = ${equipamentoId.trim()}::bpchar AND deleted_at IS NULL LIMIT 1`;
    return r[0] ? this.estacaoDe(r[0]) : null;
  }

  /** Identidade já usada por OUTRO carregador (a identidade é única entre as estações ativas). */
  async identidadeEmUso(identidade: string, equipamentoId: string): Promise<boolean> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT 1 FROM ocpp_charge_points
      WHERE lower(charge_point_id) = lower(${identidade}) AND deleted_at IS NULL
        AND (equipamento_id IS NULL OR equipamento_id <> ${equipamentoId.trim()}::bpchar) LIMIT 1`;
    return r.length > 0;
  }

  /**
   * Cria o vínculo (com a chave) ou troca a identidade de um que já existe. Tudo numa
   * transação: primeiro tira do caminho qualquer linha antiga com a identidade pedida
   * (excluída ou sem carregador), levando o histórico dela; depois a estação deste
   * carregador recebe a identidade, com o próprio histórico. Assim o histórico de uma
   * estação nunca passa para outra, em nenhum dos dois caminhos.
   */
  async vincular(p: { equipamentoId: string; plantaId: string | null; identidade: string; chaveHash: string | null }): Promise<void> {
    const eid = p.equipamentoId.trim();
    await this.prisma.$transaction(async (tx) => {
      const velhas = await tx.$queryRaw<Array<{ antiga: string; nova: string }>>`
        SELECT charge_point_id AS antiga, left(charge_point_id, 36) || '#' || TRIM(id) AS nova FROM ocpp_charge_points
        WHERE lower(charge_point_id) = lower(${p.identidade}) AND (deleted_at IS NOT NULL OR equipamento_id IS NULL)`;
      for (const v of velhas) await this.renomearHistorico(tx, v.antiga, v.nova);
      await tx.$executeRaw`
        UPDATE ocpp_charge_points SET charge_point_id = left(charge_point_id, 36) || '#' || TRIM(id), deleted_at = COALESCE(deleted_at, now())
        WHERE lower(charge_point_id) = lower(${p.identidade}) AND (deleted_at IS NOT NULL OR equipamento_id IS NULL)`;
      const atual = await tx.$queryRaw<Array<{ charge_point_id: string }>>`
        SELECT charge_point_id FROM ocpp_charge_points WHERE equipamento_id = ${eid}::bpchar AND deleted_at IS NULL LIMIT 1`;
      if (atual[0]) {
        await this.renomearHistorico(tx, atual[0].charge_point_id, p.identidade);
        await tx.$executeRaw`
          UPDATE ocpp_charge_points SET charge_point_id = ${p.identidade}, planta_id = ${p.plantaId}, updated_at = now()
          WHERE equipamento_id = ${eid}::bpchar AND deleted_at IS NULL`;
        return;
      }
      await tx.$executeRaw`
        INSERT INTO ocpp_charge_points (id, charge_point_id, equipamento_id, planta_id, chave_hash, chave_gerada_em, conectado, created_at, updated_at)
        VALUES (${this.novoId()}, ${p.identidade}, ${eid}, ${p.plantaId}, ${p.chaveHash}, now(), false, now(), now())`;
    });
  }

  async trocarChave(estacaoId: string, chaveHash: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET chave_hash = ${chaveHash}, chave_gerada_em = now(), updated_at = now() WHERE id = ${estacaoId}::bpchar`;
  }

  /**
   * Transações e leituras brutas são presas à estação pela identidade (texto). Quando a
   * identidade de uma estação muda ou é liberada, o histórico muda junto: outra estação
   * que venha a usar a mesma identidade (outro carregador, outra planta) não o herda.
   */
  private async renomearHistorico(tx: Pick<PrismaService, '$executeRaw'>, antiga: string, nova: string): Promise<void> {
    if (antiga === nova) return;
    await tx.$executeRaw`UPDATE ocpp_transactions SET charge_point_id = ${nova}, updated_at = now() WHERE charge_point_id = ${antiga}`;
    await tx.$executeRaw`UPDATE ocpp_meter_values SET charge_point_id = ${nova} WHERE charge_point_id = ${antiga}`;
  }

  /** Desfaz o vínculo sem apagar o histórico (que fica com a estação antiga): a identidade fica livre para outro cadastro. */
  async desvincular(estacaoId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.$queryRaw<Array<{ antiga: string; nova: string }>>`
        SELECT charge_point_id AS antiga, left(charge_point_id, 36) || '#' || TRIM(id) AS nova FROM ocpp_charge_points WHERE id = ${estacaoId}::bpchar`;
      if (r[0]) await this.renomearHistorico(tx, r[0].antiga, r[0].nova);
      await tx.$executeRaw`
        UPDATE ocpp_charge_points
        SET deleted_at = now(), conectado = false, chave_hash = NULL, charge_point_id = left(charge_point_id, 36) || '#' || TRIM(id), updated_at = now()
        WHERE id = ${estacaoId}::bpchar`;
    });
  }

  async gravarStatus(estacaoId: string, p: { status: string; errorCode: string; vendorErrorCode: string | null; info: string | null; quando: Date; falhaDesde: Date | null }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points
      SET status = ${p.status}, error_code = ${p.errorCode}, vendor_error_code = ${p.vendorErrorCode}, info = ${p.info},
          status_em = ${p.quando}, falha_desde = ${p.falhaDesde}, updated_at = now()
      WHERE id = ${estacaoId}::bpchar`;
  }

  async gravarPerfis(estacaoId: string, perfis: string[]): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET perfis = ${perfis.join(',').slice(0, 255)}, updated_at = now() WHERE id = ${estacaoId}::bpchar`;
  }

  async gravarDisponivel(estacaoId: string, disponivel: boolean): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET disponivel = ${disponivel}, updated_at = now() WHERE id = ${estacaoId}::bpchar`;
  }

  // ---- carregador (config, estado, leitura) -----------------------------------
  async contexto(equipamentoId: string): Promise<ContextoCarregador | null> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, TRIM(u.id) AS unidade_id, TRIM(u.nome) AS unidade_nome,
             TRIM(p.id) AS planta_id, TRIM(p.nome) AS planta_nome,
             (e.mqtt_habilitado = true AND COALESCE(TRIM(e.topico_mqtt), '') <> '') AS mqtt
      FROM equipamentos e
      LEFT JOIN unidades u ON u.id = e.unidade_id
      LEFT JOIN plantas p ON p.id = u.planta_id
      LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
      WHERE e.id = ${equipamentoId.trim()}::bpchar AND e.deleted_at IS NULL
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%' OR te.nome ILIKE '%carregador%')
      LIMIT 1`;
    if (!r[0]) return null;
    return {
      id: r[0].id, nome: r[0].nome,
      unidade: r[0].unidade_id ? { id: r[0].unidade_id, nome: r[0].unidade_nome } : null,
      planta: r[0].planta_id ? { id: r[0].planta_id, nome: r[0].planta_nome } : null,
      mqtt: r[0].mqtt === true,
    };
  }

  /** Configuração do carregador; cria a linha na primeira vez. */
  async config(equipamentoId: string): Promise<ConfigCarregador> {
    const eid = equipamentoId.trim();
    let r = await this.prisma.$queryRaw<any[]>`
      SELECT tarifa_kwh, potencia_kw, limite_tempo_min, limite_energia_kwh, limite_corrente_a, corrente_max_a, corrente_suportada,
             inicio_automatico, ultimo_soc
      FROM carregador_config WHERE equipamento_id = ${eid}::bpchar LIMIT 1`;
    if (!r[0]) {
      await this.prisma.$executeRaw`INSERT INTO carregador_config (id, equipamento_id, fonte_kwh) VALUES (${this.novoId()}, ${eid}, 'ocpp')`;
      r = [{}];
    }
    const c = r[0];
    return {
      tarifaKwh: num(c.tarifa_kwh), potenciaKw: num(c.potencia_kw),
      limiteTempoMin: num(c.limite_tempo_min), limiteEnergiaKwh: num(c.limite_energia_kwh),
      limiteCorrenteA: num(c.limite_corrente_a), correnteMaxA: num(c.corrente_max_a) ?? CORRENTE_MAX_PADRAO_A,
      correnteSuportada: c.corrente_suportada ?? null, inicioAutomatico: c.inicio_automatico === true,
      ultimoSoc: num(c.ultimo_soc),
    };
  }

  async salvarLimitesDeUso(equipamentoId: string, p: { limiteTempoMin: number | null; limiteEnergiaKwh: number | null; inicioAutomatico: boolean }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_config
      SET limite_tempo_min = ${p.limiteTempoMin}, limite_energia_kwh = ${p.limiteEnergiaKwh}, inicio_automatico = ${p.inicioAutomatico}, updated_at = now()
      WHERE equipamento_id = ${equipamentoId.trim()}::bpchar`;
  }

  async salvarCorrente(equipamentoId: string, limiteA: number | null, suportada: boolean | null): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_config SET limite_corrente_a = ${limiteA}, corrente_suportada = ${suportada}, updated_at = now()
      WHERE equipamento_id = ${equipamentoId.trim()}::bpchar`;
  }

  /** Marca só que o carregador recusou o limite de corrente (o valor em vigor não muda). */
  async marcarCorrenteNaoSuportada(equipamentoId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_config SET corrente_suportada = false, updated_at = now() WHERE equipamento_id = ${equipamentoId.trim()}::bpchar`;
  }

  async gravarEstado(equipamentoId: string, estado: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_config SET ultimo_estado = ${estado}, fonte_kwh = 'ocpp', ultima_leitura = now(), updated_at = now()
      WHERE equipamento_id = ${equipamentoId.trim()}::bpchar`;
  }

  /**
   * Última leitura: na estação (para a tela) e no carregador (registrador de energia, bateria
   * do carro). `quando` é a hora da leitura no relógio do carregador, a mesma base do
   * `status_em`: é comparando as duas que o vigia sabe se a transação segue viva.
   */
  async gravarLeitura(p: { estacaoId: string; equipamentoId: string; quando: Date; leitura: Record<string, unknown>; kwhRegistrador: number | null; soc: number | null }): Promise<void> {
    const eid = p.equipamentoId.trim();
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET leitura = ${JSON.stringify(p.leitura)}::jsonb, leitura_em = ${p.quando}, updated_at = now() WHERE id = ${p.estacaoId}::bpchar`;
    if (p.kwhRegistrador !== null) {
      await this.prisma.$executeRaw`
        UPDATE carregador_config SET ultima_leitura_kwh = ${p.kwhRegistrador}, ultima_leitura = now(), updated_at = now() WHERE equipamento_id = ${eid}::bpchar`;
    }
    if (p.soc !== null) {
      await this.prisma.$executeRaw`UPDATE carregador_config SET ultimo_soc = ${p.soc}, ultimo_soc_em = now() WHERE equipamento_id = ${eid}::bpchar`;
      await this.prisma.$executeRaw`UPDATE carregador_sessoes SET soc_inicio = COALESCE(soc_inicio, ${p.soc}) WHERE equipamento_id = ${eid}::bpchar AND status = 'ativa'`;
    }
  }

  /**
   * Leitura na série do equipamento (`equipamentos_dados`), a mesma que alimenta
   * `/equipamentos/:id/dados/atual`, o histórico e o resumo diário. Mesmo formato do MQTT.
   */
  async gravarDado(equipamentoId: string, quando: Date, dados: Record<string, unknown>, potenciaKw: number | null, energiaKwh: number | null): Promise<void> {
    const ts = emSegundos(quando);
    const campos = { dados: dados as any, fonte: 'OCPP', timestamp_fim: ts, num_leituras: 1, qualidade: 'bom', energia_kwh: energiaKwh, potencia_ativa_kw: potenciaKw };
    await this.prisma.equipamentos_dados.upsert({
      where: { uk_equipamento_timestamp: { equipamento_id: equipamentoId.trim(), timestamp_dados: ts } },
      update: campos,
      create: { equipamento_id: equipamentoId.trim(), timestamp_dados: ts, ...campos },
    });
  }

  // ---- recargas ---------------------------------------------------------------
  private sessaoDe(r: any): SessaoCarregador {
    return {
      id: r.id, equipamentoId: r.equipamento_id, plantaId: t(r.planta_id), moradorId: t(r.morador_id), moradorNome: r.morador_nome ?? null,
      inicio: r.inicio, kwhInicio: num(r.kwh_inicio), kwhTotal: num(r.kwh_total),
      status: r.status === 'encerrada' ? 'encerrada' : 'ativa',
      transactionId: r.ocpp_transaction_id === null || r.ocpp_transaction_id === undefined ? null : Number(r.ocpp_transaction_id),
      idTag: r.ocpp_id_tag ?? null, limiteTempoMin: num(r.limite_tempo_min), limiteEnergiaKwh: num(r.limite_energia_kwh),
      motivoFim: r.motivo_fim ?? null, paradaPedidaEm: r.parada_pedida_em ?? null, liberadoPor: r.liberado_por ?? 'porteiro',
    };
  }

  async sessaoAtiva(equipamentoId: string): Promise<SessaoCarregador | null> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, kwh_total, status,
             ocpp_transaction_id, ocpp_id_tag, limite_tempo_min, limite_energia_kwh, motivo_fim, parada_pedida_em, liberado_por
      FROM carregador_sessoes WHERE equipamento_id = ${equipamentoId.trim()}::bpchar AND status = 'ativa'
      ORDER BY inicio DESC LIMIT 1`;
    return r[0] ? this.sessaoDe(r[0]) : null;
  }

  /** Recarga da transação NESTE carregador (o número da transação sozinho não identifica a recarga). */
  async sessaoPorTransacao(equipamentoId: string, transactionId: number): Promise<SessaoCarregador | null> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, kwh_total, status,
             ocpp_transaction_id, ocpp_id_tag, limite_tempo_min, limite_energia_kwh, motivo_fim, parada_pedida_em, liberado_por
      FROM carregador_sessoes
      WHERE equipamento_id = ${equipamentoId.trim()}::bpchar AND ocpp_transaction_id = ${transactionId}
      ORDER BY inicio DESC LIMIT 1`;
    return r[0] ? this.sessaoDe(r[0]) : null;
  }

  /**
   * Recarga deste carregador, com esta tag, que caiu nas últimas 24 h sem ser parada por
   * ninguém (queda de energia, reinício, fim não confirmado): se o carregador voltar a
   * carregar com a mesma tag, é a continuação dela.
   */
  async sessaoRetomavel(equipamentoId: string, tag: string): Promise<SessaoCarregador | null> {
    // Só a ÚLTIMA recarga com a tag conta: se ela foi parada por alguém, a tag não volta a valer.
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT u.* FROM (
        SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, kwh_total, status,
               ocpp_transaction_id, ocpp_id_tag, limite_tempo_min, limite_energia_kwh, motivo_fim, parada_pedida_em, liberado_por, fim
        FROM carregador_sessoes
        WHERE equipamento_id = ${equipamentoId.trim()}::bpchar AND UPPER(ocpp_id_tag) = ${tag.trim().toUpperCase()}
        ORDER BY inicio DESC, ocpp_transaction_id DESC NULLS LAST LIMIT 1
      ) u
      WHERE u.status = 'encerrada' AND u.fim > now()::timestamp - interval '24 hours'
        AND u.motivo_fim IN ('queda_energia', 'reinicio', 'sem_confirmacao')`;
    return r[0] ? this.sessaoDe(r[0]) : null;
  }

  /** Recarga fechada sem a confirmação do carregador e que continua medindo: volta a ficar aberta. */
  async reabrir(sessaoId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes SET status = 'ativa', fim = NULL, motivo_fim = NULL, parada_pedida_em = NULL, updated_at = now()
      WHERE id = ${sessaoId}::bpchar AND status = 'encerrada' AND motivo_fim = 'sem_confirmacao'`;
  }

  /** Recargas abertas em carregador OCPP, com o que o vigia precisa da estação. */
  async sessoesAtivasOcpp(): Promise<Array<SessaoCarregador & { chargePointId: string; statusEstacao: string | null; statusEm: Date | null; conectado: boolean; ultimaDesconexao: Date | null; ultimaConexao: Date | null; leituraEm: Date | null }>> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(s.id) AS id, TRIM(s.equipamento_id) AS equipamento_id, s.planta_id, s.morador_id, s.morador_nome, s.inicio, s.kwh_inicio, s.kwh_total, s.status,
             s.ocpp_transaction_id, s.ocpp_id_tag, s.limite_tempo_min, s.limite_energia_kwh, s.motivo_fim, s.parada_pedida_em, s.liberado_por,
             cp.charge_point_id, cp.status AS status_estacao, cp.status_em, cp.conectado, cp.ultima_desconexao, cp.ultima_conexao, cp.leitura_em
      FROM carregador_sessoes s
      JOIN ocpp_charge_points cp ON cp.equipamento_id = s.equipamento_id AND cp.deleted_at IS NULL
      WHERE s.status = 'ativa'`;
    return r.map((x) => ({
      ...this.sessaoDe(x), chargePointId: x.charge_point_id, statusEstacao: x.status_estacao ?? null,
      statusEm: x.status_em ?? null, conectado: !!x.conectado, ultimaDesconexao: x.ultima_desconexao ?? null,
      ultimaConexao: x.ultima_conexao ?? null, leituraEm: x.leitura_em ?? null,
    }));
  }

  async criarSessao(p: {
    equipamentoId: string; plantaId: string | null; moradorId: string | null; moradorNome: string; inicio: Date; kwhInicio: number | null;
    liberadoPor: string; liberadoPorUser: string; tarifaKwh: number | null; socInicio: number | null;
    transactionId: number | null; idTag: string; limiteTempoMin: number | null; limiteEnergiaKwh: number | null;
  }): Promise<string> {
    const id = this.novoId();
    await this.prisma.$executeRaw`
      INSERT INTO carregador_sessoes (id, equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, liberado_por, liberado_por_user,
                                      status, tarifa_kwh, soc_inicio, ocpp_transaction_id, ocpp_id_tag, limite_tempo_min, limite_energia_kwh)
      VALUES (${id}, ${p.equipamentoId.trim()}, ${p.plantaId}, ${p.moradorId}, ${p.moradorNome.slice(0, 120)}, ${p.inicio}, ${p.kwhInicio},
              ${p.liberadoPor}, ${p.liberadoPorUser.slice(0, 120)}, 'ativa', ${p.tarifaKwh}, ${p.socInicio}, ${p.transactionId}, ${p.idTag},
              ${p.limiteTempoMin}, ${p.limiteEnergiaKwh})`;
    return id;
  }

  /** O carregador confirmou o início (StartTransaction) da recarga liberada no NexON. */
  async anexarTransacao(sessaoId: string, transactionId: number, kwhInicio: number, inicio: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes SET ocpp_transaction_id = ${transactionId}, kwh_inicio = ${kwhInicio}, kwh_fim = ${kwhInicio}, kwh_total = 0,
             inicio = ${inicio}, updated_at = now()
      WHERE id = ${sessaoId}::bpchar`;
  }

  /** Leitura parcial: o registrador de energia agora (kWh). */
  async atualizarEnergia(sessaoId: string, kwhRegistrador: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET kwh_fim = ${kwhRegistrador},
          kwh_total = CASE WHEN kwh_inicio IS NOT NULL THEN GREATEST(${kwhRegistrador}::numeric - kwh_inicio, 0) ELSE kwh_total END,
          updated_at = now()
      WHERE id = ${sessaoId}::bpchar AND status = 'ativa'`;
  }

  /** Fecha (ou corrige o fecho de) uma recarga. `kwhFim` null = fica a última leitura. */
  async encerrar(sessaoId: string, p: { fim: Date; kwhFim: number | null; motivo: string }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET fim = ${p.fim}, kwh_fim = COALESCE(${p.kwhFim}::numeric, kwh_fim),
          kwh_total = CASE WHEN COALESCE(${p.kwhFim}::numeric, kwh_fim) IS NOT NULL AND kwh_inicio IS NOT NULL
                           THEN GREATEST(COALESCE(${p.kwhFim}::numeric, kwh_fim) - kwh_inicio, 0) ELSE kwh_total END,
          ocioso_min = CASE WHEN ocioso_inicio IS NOT NULL THEN GREATEST(EXTRACT(EPOCH FROM (${p.fim}::timestamp - ocioso_inicio)) / 60, 0)::int ELSE 0 END,
          motivo_fim = ${p.motivo.slice(0, 24)}, status = 'encerrada', updated_at = now()
      WHERE id = ${sessaoId}::bpchar`;
  }

  /** Recarga liberada que nunca começou no carregador: não mediu nada, sai da lista. */
  async cancelar(sessaoId: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM carregador_sessoes WHERE id = ${sessaoId}::bpchar AND ocpp_transaction_id IS NULL AND status = 'ativa'`;
  }

  /** O NexON pediu a parada (limite ou tela): guarda o motivo até o carregador confirmar. */
  async pedirParada(sessaoId: string, motivo: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes SET motivo_fim = ${motivo.slice(0, 24)}, parada_pedida_em = now(), updated_at = now() WHERE id = ${sessaoId}::bpchar`;
  }

  // ---- moradores --------------------------------------------------------------
  /**
   * Morador dono do cartão, SÓ na planta do carregador. Carregador sem planta não autoriza
   * cartão nenhum: sem a planta, o cartão de um condomínio abriria o carregador de outro.
   */
  async moradorPorTag(plantaId: string | null, tag: string): Promise<MoradorTag | null> {
    const planta = String(plantaId ?? '').trim();
    if (!planta) return null;
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, nome, ativo, to_char(validade, 'YYYY-MM-DD') AS validade
      FROM moradores
      WHERE UPPER(TRIM(tag_uid)) = ${tag.trim().toUpperCase()} AND deleted_at IS NULL AND TRIM(planta_id) = ${planta}
      ORDER BY ativo DESC LIMIT 1`;
    return r[0] ? { id: r[0].id, nome: r[0].nome, ativo: !!r[0].ativo, validade: r[0].validade ?? null } : null;
  }

  // ---- trilha e alarme --------------------------------------------------------
  /** Trilha do carregador (logs_mqtt tipo 'comando'): aba Registros e busca de logs. Nunca lança. */
  async trilha(equipamentoId: string, mensagem: string, semantico: string, extra: { usuarioId?: string | null; status?: string; severidade?: 'INFO' | 'WARN' | 'ERROR'; tecnico?: string | null; latenciaMs?: number | null } = {}): Promise<void> {
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: equipamentoId.trim(), mensagem: mensagem.slice(0, 500),
          severidade: extra.severidade ?? 'INFO', status: extra.status ?? 'ok',
          usuario_id: extra.usuarioId ? String(extra.usuarioId).trim() : null,
          comando_semantico: semantico, comando_tecnico: extra.tecnico ? extra.tecnico.slice(0, 255) : null,
          latency_ms: extra.latenciaMs ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`trilha não gravada: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Abre o alarme da falha (logs_mqtt tipo 'alerta', `dados_snapshot.kind = 'carregador_falha'`). */
  async abrirFalha(equipamentoId: string, f: Falha, mensagem: string, extra: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'alerta', equipamento_id: equipamentoId.trim(), mensagem: mensagem.slice(0, 500), severidade: f.severidade,
          dados_snapshot: { kind: 'carregador_falha', codigo: f.codigo, ocpp: f.ocpp, titulo: f.titulo, desde: new Date().toISOString(), ...extra } as any,
        },
      });
    } catch (e) {
      this.logger.warn(`alarme não gravado: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Fecha os alarmes de falha abertos do carregador. */
  async resolverFalhas(equipamentoId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE logs_mqtt
      SET resolvido_em = now(), dados_snapshot = COALESCE(dados_snapshot, '{}'::jsonb) || jsonb_build_object('normalizado_em', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      WHERE tipo = 'alerta' AND resolvido_em IS NULL AND equipamento_id = ${equipamentoId.trim()}::bpchar
        AND (dados_snapshot->>'kind') = 'carregador_falha'`.catch((e) => this.logger.warn(`alarme não resolvido: ${e?.message}`));
  }
}
