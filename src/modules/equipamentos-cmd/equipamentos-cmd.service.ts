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
    const topico = equipamento.topico_mqtt?.trim();
    if (!topico) {
      throw new BadRequestException(
        `Equipamento ${equipamento.nome} nao tem topico_mqtt configurado`,
      );
    }

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
    const topico = ton.topico_mqtt?.trim();
    if (!topico) {
      throw new BadRequestException(`TON "${ton.nome}" sem topico_mqtt configurado.`);
    }

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
}
