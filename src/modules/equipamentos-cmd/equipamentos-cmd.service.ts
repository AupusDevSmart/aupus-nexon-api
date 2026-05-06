import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import { SendCommandDto } from './dto/send-command.dto';
import { CommandResultDto } from './dto/command-result.dto';

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
  ) {}

  async sendCommand(
    equipamentoId: string,
    dto: SendCommandDto,
  ): Promise<CommandResultDto> {
    const trimmedId = equipamentoId.trim();

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
}
