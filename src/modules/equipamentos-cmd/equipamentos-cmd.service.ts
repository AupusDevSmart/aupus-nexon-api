import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import { SendCommandDto } from './dto/send-command.dto';
import { CommandResultDto } from './dto/command-result.dto';
import { AcionarPontoResultDto } from './dto/acionar-ponto-result.dto';

/**
 * Service para envio de comandos MQTT a equipamentos.
 *
 * Wrapper sobre MqttService.publishCommand que:
 *  - resolve equipamento via FK e valida pre-requisitos (mqtt_habilitado, topico_mqtt)
 *  - mapeia status do ack do TON para HTTP semantico (200/502/504)
 *  - mede e injeta latency_ms na resposta
 *  - loga cada tentativa com nivel apropriado para observabilidade
 *
 * Escalabilidade futura (sem mudanca de contrato):
 *  - validacao de cmd contra tipos_equipamentos.mqtt_schema (quando popular)
 *  - audit trail em tabela equipamento_comandos_log
 *  - throttling por equipamento (ex: max N comandos/min)
 *  - autorizacao granular por tipo (ex: so admin pode comandar disjuntor)
 */
@Injectable()
export class EquipamentosCmdService {
  private readonly logger = new Logger(EquipamentosCmdService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  async sendCommand(
    equipamentoId: string,
    dto: SendCommandDto,
    user?: ScopedUser,
  ): Promise<CommandResultDto> {
    const trimmedId = equipamentoId.trim();
    if (user) await this.scopeService.assertEntityInScope('equipamento', trimmedId, user);

    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: trimmedId, deleted_at: null },
      select: {
        id: true,
        nome: true,
        topico_mqtt: true,
        mqtt_habilitado: true,
      },
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${trimmedId} nao encontrado`);
    }
    if (!equipamento.mqtt_habilitado) {
      throw new BadRequestException(
        `Equipamento ${equipamento.nome} esta com mqtt_habilitado=false`,
      );
    }
    const baseTopico = equipamento.topico_mqtt?.trim();
    if (!baseTopico) {
      throw new BadRequestException(
        `Equipamento ${equipamento.nome} nao tem topico_mqtt configurado`,
      );
    }
    // Modo SIMULACAO/LAB: publica em TESTE/<topico>/cmd (onde o firmware de
    // simulacao escuta) em vez do topico real. Testa o pipeline de comando ponta
    // a ponta (backend -> MQTT -> TON-sim -> aciona rele -> ack) sem tocar o
    // equipamento de producao. Ack volta em TESTE/<topico>/cmd/ack.
    // Com dto.testMac (remap de bancada), reescreve .../satellite/<MAC> pro MAC do
    // board de bancada — roteia pro board físico de teste sem tocar no cadastro.
    const topico = dto.sim
      ? `TESTE/${this.remapSatelliteMac(baseTopico, dto.testMac)}`
      : baseTopico;

    if (!this.mqtt.isConnected()) {
      throw new ServiceUnavailableException(
        'Broker MQTT nao conectado no momento',
      );
    }

    const startedAt = Date.now();
    let ack;
    try {
      ack = await this.mqtt.publishCommand(topico, dto.cmd);
    } catch (err) {
      // publishCommand rejeita apos esgotar maxAttempts (default 3 x 5s = 15s).
      // Este eh o caminho de timeout — TON offline ou MQTT engasgado.
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      this.logger.warn(
        `[cmd] timeout/erro publish para equipamento ${equipamento.nome} (${trimmedId}): ${message}`,
      );
      throw new GatewayTimeoutException(
        `TON nao respondeu ao comando dentro do timeout (${message})`,
      );
    }

    const latency_ms = Date.now() - startedAt;

    if (ack.status === 'error') {
      // TON respondeu com erro semantico (comando invalido, recusado, etc).
      // 502 sinaliza que o gateway downstream (TON) recusou.
      this.logger.warn(
        `[cmd] equipamento ${equipamento.nome} (${trimmedId}) recusou comando: ${ack.msg} (latency=${latency_ms}ms)`,
      );
      throw new BadGatewayException({
        message: `TON recusou o comando: ${ack.msg}`,
        cmd_id: ack.cmd_id,
        latency_ms,
      });
    }

    // status 'ok' ou 'duplicate' — tratamos ambos como sucesso.
    this.logger.log(
      `[cmd] equipamento ${equipamento.nome} (${trimmedId}) ack=${ack.status} (latency=${latency_ms}ms)`,
    );

    return {
      cmd_id: ack.cmd_id,
      status: ack.status,
      msg: ack.msg,
      ts: ack.ts,
      latency_ms,
    };
  }

  // ============================================================================
  // ACIONAR PONTO — resolve mapeamento ton_bo e executa pulso
  // ============================================================================

  /**
   * Aciona um ponto de tipo `comando` de um equipamento alvo.
   *
   * Resolve via `ton_bo`: qual TON controla aquele ponto, em qual BO (rele),
   * com qual `pulso_ms`. Publica:
   *   `r{N} on`  (com ack via publishCommand — confirma TON online)
   *   wait pulso_ms
   *   `r{N} off` (fire-and-forget via mqtt.publish — pulso deterministico)
   *
   * Erros mapeados para HTTP:
   *   - 404: equipamento ou ponto nao encontrado
   *   - 400: equipamento sem automacao, ponto nao eh comando/inativo, sem mapeamento ton_bo, TON sem topico_mqtt
   *   - 503: broker MQTT desconectado
   *   - 502: TON respondeu erro
   *   - 504: TON nao respondeu (timeout)
   */
  async acionarPonto(
    equipamentoId: string,
    pontoId: string,
    user?: ScopedUser,
    sim = false,
    testMac?: string,
  ): Promise<AcionarPontoResultDto> {
    const eqId = equipamentoId.trim();
    const pId = pontoId.trim();
    if (user) await this.scopeService.assertEntityInScope('equipamento', eqId, user);

    // 1. Equipamento + ponto
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: eqId, deleted_at: null },
      select: { id: true, nome: true, automacao: true },
    });
    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${eqId} nao encontrado`);
    }
    if (!equipamento.automacao) {
      throw new BadRequestException(
        `Equipamento "${equipamento.nome}" nao tem automacao habilitada.`,
      );
    }

    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pId, equipamento_id: eqId, deleted_at: null },
      select: { id: true, tipo: true, nome: true, ativo: true },
    });
    if (!ponto) {
      throw new NotFoundException(
        `Ponto ${pId} nao encontrado no equipamento ${equipamento.nome}`,
      );
    }
    if (ponto.tipo !== 'comando') {
      throw new BadRequestException(
        `Ponto "${ponto.nome}" eh tipo "${ponto.tipo}" — apenas pontos de tipo 'comando' podem ser acionados.`,
      );
    }
    if (!ponto.ativo) {
      throw new BadRequestException(`Ponto "${ponto.nome}" esta inativo.`);
    }

    // 2-relé. Se o ponto está mapeado como BO de um RELÉ (io_config nos props do
    // componente IoT), o comando vai por MODBUS: a TON gateway recebe
    // {"device":relé,"cmd":X} e escreve o coil (func 0x05, do catálogo). Write único
    // (sem pulso ON/OFF). Se não houver mapeamento de relé, cai no fluxo ton_bo abaixo.
    const rele = await this.resolveReleBo(pId);
    if (rele) {
      if (!this.mqtt.isConnected()) {
        throw new ServiceUnavailableException('Broker MQTT nao conectado no momento.');
      }
      const topicoRele = sim
        ? `TESTE/${this.remapSatelliteMac(rele.tonTopico, testMac)}`
        : rele.tonTopico;
      const comandoSemanticoR = `${equipamento.nome} · ${ponto.nome}`;
      const cmdTecnicoR = `modbus ${rele.relayName}/${rele.cmdId}`;
      const startedAtR = Date.now();
      const payload = JSON.stringify({ device: rele.relayName, cmd: rele.cmdId });
      let ackR;
      try {
        ackR = await this.mqtt.publishCommand(topicoRele, payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro desconhecido';
        this.logger.warn(
          `[acionar-ponto] timeout TON ${rele.tonNome} rele cmd=${cmdTecnicoR}: ${message}`,
        );
        throw new GatewayTimeoutException(
          `TON "${rele.tonNome}" nao respondeu ao comando ${cmdTecnicoR} dentro do timeout.`,
        );
      }
      const latencyR = Date.now() - startedAtR;
      if (ackR.status === 'error') {
        throw new BadGatewayException({
          message: `Relé recusou o comando: ${ackR.msg}`,
          cmd_id: ackR.cmd_id,
          latency_ms: latencyR,
        });
      }
      this.logger.log(
        `[acionar-ponto] ${comandoSemanticoR} -> RELÉ ${rele.relayName}/${rele.cmdId} via TON ${rele.tonNome} status=${ackR.status} latency=${latencyR}ms`,
      );
      try {
        await this.prisma.logs_mqtt.create({
          data: {
            tipo: 'comando',
            equipamento_id: eqId,
            mensagem: `${comandoSemanticoR} (${cmdTecnicoR})`,
            severidade: ackR.status === 'ok' ? 'INFO' : 'WARN',
            cmd_id: ackR.cmd_id,
            status: ackR.status,
            latency_ms: latencyR,
            comando_tecnico: cmdTecnicoR,
            comando_semantico: comandoSemanticoR,
          },
        });
      } catch (logErr) {
        this.logger.warn(
          `[acionar-ponto] falha ao persistir log (relé): ${(logErr as Error).message}`,
        );
      }
      return {
        cmd_id: ackR.cmd_id,
        status: ackR.status,
        msg: ackR.msg,
        latency_ms: latencyR,
        pulso_ms: 0,
        comando_tecnico: cmdTecnicoR,
        comando_semantico: comandoSemanticoR,
        bo_numero: 0,
      };
    }

    // 2. Mapeamento ton_bo ativo
    const bo = await this.prisma.ton_bo.findFirst({
      where: { equipamento_ponto_id: pId, ativo: true, deleted_at: null },
      select: { id: true, ton_id: true, bo_numero: true, pulso_ms: true },
    });
    if (!bo) {
      throw new BadRequestException(
        `Ponto "${ponto.nome}" nao esta mapeado em nenhum BO ativo de TON. ` +
          `Configure no editor IoT (modal da TON -> Configurar BOs).`,
      );
    }

    // 3. TON (equipamento controlador)
    const ton = await this.prisma.equipamentos.findFirst({
      where: { id: bo.ton_id, deleted_at: null },
      select: {
        id: true,
        nome: true,
        topico_mqtt: true,
        mqtt_habilitado: true,
      },
    });
    if (!ton) {
      throw new BadRequestException(
        `TON do mapeamento (${bo.ton_id}) nao encontrada ou foi removida.`,
      );
    }
    if (!ton.mqtt_habilitado) {
      throw new BadRequestException(`TON "${ton.nome}" com mqtt_habilitado=false.`);
    }
    const baseTopico = ton.topico_mqtt?.trim();
    if (!baseTopico) {
      throw new BadRequestException(`TON "${ton.nome}" sem topico_mqtt configurado.`);
    }
    // Modo SIMULAÇÃO/LAB: o pulso ON->OFF vai pra TESTE/<topico>/cmd (firmware de
    // simulação), não pro tópico real — testa o pipeline sem tocar produção.
    // Com testMac (remap de bancada), reescreve o segmento .../satellite/<MAC> pro
    // MAC do board de bancada antes do prefixo TESTE/ — roteia pro board físico de
    // teste sem tocar no cadastro. MAC distinto do de campo => nunca aciona o real.
    const topico = sim
      ? `TESTE/${this.remapSatelliteMac(baseTopico, testMac)}`
      : baseTopico;

    // 4. Broker MQTT online
    if (!this.mqtt.isConnected()) {
      throw new ServiceUnavailableException('Broker MQTT nao conectado no momento.');
    }

    const cmdOn = `r${bo.bo_numero} on`;
    const cmdOff = `r${bo.bo_numero} off`;
    const comandoSemantico = `${equipamento.nome} · ${ponto.nome}`;
    const startedAt = Date.now();

    // 5. Pulso ON com ack — garante que TON esta online e processou
    let ack;
    try {
      ack = await this.mqtt.publishCommand(topico, cmdOn);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      this.logger.warn(
        `[acionar-ponto] timeout TON ${ton.nome} (${ton.id}) cmd=${cmdOn}: ${message}`,
      );
      throw new GatewayTimeoutException(
        `TON "${ton.nome}" nao respondeu ao comando ${cmdOn} dentro do timeout.`,
      );
    }

    const latency_ms = Date.now() - startedAt;

    if (ack.status === 'error') {
      this.logger.warn(
        `[acionar-ponto] TON ${ton.nome} recusou cmd=${cmdOn}: ${ack.msg} (latency=${latency_ms}ms)`,
      );
      throw new BadGatewayException({
        message: `TON recusou o comando: ${ack.msg}`,
        cmd_id: ack.cmd_id,
        latency_ms,
      });
    }

    // 6. Wait pulso_ms — backend mantem o estado fisico do pulso
    await this.sleep(bo.pulso_ms);

    // 7. Pulso OFF — envelope completo {cmd_id, cmd} com novo UUID, sem aguardar ack.
    //    Firmware do TON exige cmd_id no envelope (so payload string puro tambem
    //    funciona, mas envelope mantem o padrao). Pulso fica preciso porque nao
    //    espera ack do OFF (mqtt QoS 1 garante delivery em condicoes normais).
    try {
      const offEnvelope = JSON.stringify({ cmd_id: randomUUID(), cmd: cmdOff });
      await this.mqtt.publish(`${topico}/cmd`, offEnvelope, {
        qos: 1,
        retain: false,
      });
    } catch (err) {
      // Se OFF falhar, log warning mas nao quebra. ON ja foi feito; um relay
      // que ficar ligado eh problema operacional, mas a action funcionou.
      this.logger.error(
        `[acionar-ponto] CRITICO: falha ao publicar ${cmdOff} apos ON OK em TON ${ton.nome}: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `[acionar-ponto] ${comandoSemantico} -> TON ${ton.nome} ${cmdOn} (${bo.pulso_ms}ms) ${cmdOff} status=${ack.status} latency_on=${latency_ms}ms`,
    );

    // Audit log polivalente em logs_mqtt (tipo='comando').
    // Falha de log nao impacta o retorno — operacao ja foi executada.
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando',
          equipamento_id: eqId,
          mensagem: `${comandoSemantico} (${cmdOn} -> ${bo.pulso_ms}ms -> ${cmdOff})`,
          severidade: ack.status === 'ok' ? 'INFO' : 'WARN',
          cmd_id: ack.cmd_id,
          status: ack.status,
          latency_ms,
          ton_id: ton.id,
          ton_bo_id: bo.id,
          comando_tecnico: `${cmdOn} -> ${cmdOff}`,
          comando_semantico: comandoSemantico,
        },
      });
    } catch (logErr) {
      this.logger.warn(
        `[acionar-ponto] falha ao persistir log em logs_mqtt: ${(logErr as Error).message}`,
      );
    }

    return {
      cmd_id: ack.cmd_id,
      status: ack.status,
      msg: ack.msg,
      latency_ms,
      pulso_ms: bo.pulso_ms,
      comando_tecnico: `${cmdOn} -> ${cmdOff}`,
      comando_semantico: comandoSemantico,
      bo_numero: bo.bo_numero,
    };
  }

  /** Promisified sleep — usado pelo pulso. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Se o ponto está mapeado como BO de um RELÉ (io_config nos props do componente IoT),
   * resolve: nome do relé (device_name do firmware) + cmd_id do catálogo + a TON gateway
   * (BFS nas conexões do projeto) que lê o relé. Retorna null se não for mapeamento de relé.
   */
  private async resolveReleBo(pontoId: string): Promise<{
    relayName: string;
    cmdId: string;
    tonTopico: string;
    tonNome: string;
  } | null> {
    // 1. Componente de relé cujo props.io_config.bo mapeia este ponto.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; projeto_id: string; nome: string | null; cmd_id: string }>
    >`
      SELECT c.id, c.projeto_id, c.props->>'name' AS nome, k.key AS cmd_id
      FROM iot_componentes c
      CROSS JOIN LATERAL jsonb_each(COALESCE(c.props->'io_config'->'bo', '{}'::jsonb)) k
      WHERE TRIM(k.value->>'ponto_id') = ${pontoId}
      LIMIT 1
    `;
    if (!rows?.length) return null;
    const relay = rows[0];
    const relayName = (relay.nome ?? '').trim();
    if (!relayName) return null;

    // 2. TON gateway: BFS nas conexões do projeto até a TON (com equipamento) mais próxima.
    const [comps, conns] = await Promise.all([
      this.prisma.iot_componentes.findMany({
        where: { projeto_id: relay.projeto_id },
        select: { id: true, tipo: true, equipamento_id: true },
      }),
      this.prisma.iot_conexoes.findMany({
        where: { projeto_id: relay.projeto_id },
        select: { from_comp_id: true, to_comp_id: true },
      }),
    ]);
    const adj = new Map<string, string[]>();
    for (const cn of conns) {
      const a = cn.from_comp_id;
      const b = cn.to_comp_id;
      if (!a || !b) continue;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
    const byId = new Map(comps.map((c) => [c.id, c]));
    const isTon = (t?: string | null) => String(t ?? '').toLowerCase().startsWith('ton');
    const visited = new Set<string>([relay.id]);
    const queue: string[] = [relay.id];
    let tonEquipId: string | null = null;
    while (queue.length) {
      const id = queue.shift() as string;
      const comp = byId.get(id);
      if (id !== relay.id && comp && isTon(comp.tipo) && comp.equipamento_id) {
        tonEquipId = comp.equipamento_id.trim();
        break;
      }
      for (const nb of adj.get(id) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    if (!tonEquipId) return null;

    const ton = await this.prisma.equipamentos.findFirst({
      where: { id: tonEquipId, deleted_at: null },
      select: { nome: true, topico_mqtt: true, mqtt_habilitado: true },
    });
    const topico = ton?.topico_mqtt?.trim();
    if (!topico || !ton?.mqtt_habilitado) return null;

    return { relayName, cmdId: relay.cmd_id, tonTopico: topico, tonNome: ton.nome };
  }

  /**
   * Remap de bancada (só no modo simulação): se `testMac` vier e o tópico tiver um
   * segmento `.../satellite/<algo>`, troca `<algo>` (MAC cadastrado OU o placeholder
   * "MAC") pelo MAC do board de bancada. Sem testMac, devolve o tópico inalterado.
   * Não persiste nada — só afeta o tópico TESTE/ desta publicação.
   */
  private remapSatelliteMac(baseTopico: string, testMac?: string): string {
    const mac = testMac?.trim();
    if (!mac) return baseTopico;
    if (!/\/satellite\/[^/]+/.test(baseTopico)) return baseTopico;
    return baseTopico.replace(/(\/satellite\/)[^/]+/, `$1${mac.toUpperCase()}`);
  }
}
