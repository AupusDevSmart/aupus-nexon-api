import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import {
  TriggerOtaDto,
  CompilePublishOtaDto,
  OtaStatusResponseDto,
} from './dto/trigger-ota.dto';

interface CompileArtifactResponse {
  name: string;
  version: string;
  filename: string;
  path: string;
  size: number;
  md5: string;
  sha256: string;
  build_time_ms: number;
  ram_usage?: string;
  flash_usage?: string;
}

@Injectable()
export class OtaService {
  private readonly logger = new Logger(OtaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Publica um comando OTA para um equipamento específico.
   * Requer que o equipamento tenha topico_mqtt configurado.
   */
  async triggerOta(
    equipamentoId: string,
    dto: TriggerOtaDto,
  ): Promise<OtaStatusResponseDto> {
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      select: { id: true, nome: true, topico_mqtt: true, mqtt_habilitado: true },
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }
    if (!equipamento.mqtt_habilitado || !equipamento.topico_mqtt) {
      throw new BadRequestException(
        'Equipamento não tem MQTT habilitado ou topico_mqtt vazio',
      );
    }

    const topicBase = equipamento.topico_mqtt.replace(/\/+$/, '');
    const topic = `${topicBase}/ota/cmd`;
    const otaStatusTopic = `${topicBase}/ota/status`;
    const payload = {
      url: dto.url,
      version: dto.version,
      ...(dto.md5 ? { md5: dto.md5 } : {}),
      ...(dto.target_mac ? { target_mac: dto.target_mac } : {}),
    };

    if (!this.mqtt.isConnected()) {
      throw new ServiceUnavailableException('MQTT broker não conectado no momento');
    }

    try {
      // Publica com retain=true para que TON receba o cmd assim que conectar
      // (mesmo se estava offline no momento do publish). MQTT broker guarda
      // a ultima mensagem retida por topico — ao reconectar, cliente recebe.
      await this.mqtt.publish(topic, JSON.stringify(payload), {
        qos: 1,
        retain: true,
      });

      // Auto-clear do retained: caminho normal e' via `ota/status` (TON
      // confirma success/rebooting). Fallback de 60s evita retained ficar
      // preso se TON nunca confirmar (ex: download falhou e nao chegou a publicar).
      //
      // Sem isso, ao reboot o TON re-aplica o cmd retido em loop.
      let cleared = false;
      let fallbackTimer: NodeJS.Timeout | null = null;

      const clearRetained = async (reason: string): Promise<void> => {
        if (cleared) return;
        cleared = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        this.mqtt.removeOtaStatusListener(otaStatusTopic);
        try {
          await this.mqtt.publish(topic, '', { qos: 1, retain: true });
          this.logger.log(`OTA retained limpo em ${topic} (motivo: ${reason})`);
        } catch (err) {
          this.logger.warn(
            `Falha limpando OTA retained em ${topic}: ${(err as Error).message}`,
          );
        }
      };

      this.mqtt.addOtaStatusListener(otaStatusTopic, (data: any) => {
        const state = data?.state;
        if (state === 'success' || state === 'rebooting' || state === 'failed') {
          void clearRetained(`state=${state}`);
        }
      });

      // 180s: download (~35s) + reboot (~35s) + folga. Antes era 60s, mas
      // disparava durante downloads grandes — TON respondia "already_in_progress"
      // ao cmd vazio publicado pelo clear. Caminho normal continua via state=success
      // (chega bem antes do timeout).
      fallbackTimer = setTimeout(() => {
        void clearRetained('timeout 180s');
      }, 180000);
    } catch (err) {
      this.logger.error(
        `Falha publicando OTA em ${topic}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('Falha ao publicar comando OTA');
    }

    this.logger.log(
      `OTA disparado para ${equipamento.nome} (${equipamentoId}) ` +
        `-> ${topic} version=${dto.version} (retained=true, ` +
        `auto-clear via ota/status ou fallback 60s)`,
    );

    return {
      published: true,
      topic,
      url: dto.url,
      version: dto.version,
      md5: dto.md5 ?? '',
      size: 0,
    };
  }

  /**
   * Fluxo completo: compila o projeto, salva artefato, publica OTA.
   * Usado quando o NexOn gera o firmware direto e quer atualizar o device.
   */
  async compileAndPublish(
    equipamentoId: string,
    dto: CompilePublishOtaDto,
  ): Promise<OtaStatusResponseDto> {
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      select: { id: true, nome: true, topico_mqtt: true, mqtt_habilitado: true },
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }
    if (!equipamento.mqtt_habilitado || !equipamento.topico_mqtt) {
      throw new BadRequestException(
        'Equipamento não tem MQTT habilitado ou topico_mqtt vazio',
      );
    }

    const artifact = await this.compileArtifact(dto);
    const publicBase = this.getPublicBaseUrl();
    const url = `${publicBase}${artifact.path}`;

    const result = await this.triggerOta(equipamentoId, {
      url,
      version: artifact.version,
      md5: artifact.md5,
      ...(dto.target_mac ? { target_mac: dto.target_mac } : {}),
    });

    return { ...result, size: artifact.size, md5: artifact.md5 };
  }

  /**
   * Chama o firmware-compiler (localhost:3210) para compilar + salvar o artefato.
   */
  private async compileArtifact(
    dto: CompilePublishOtaDto,
  ): Promise<CompileArtifactResponse> {
    const compilerUrl =
      this.config.get<string>('IOT_COMPILER_URL') || 'http://127.0.0.1:3210';
    const endpoint = `${compilerUrl.replace(/\/+$/, '')}/publish-artifact`;

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: dto.files,
          name: dto.name,
          version: dto.version,
        }),
      });
    } catch (err) {
      this.logger.error(
        `firmware-compiler inacessível em ${endpoint}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Serviço de compilação indisponível',
      );
    }

    const data = (await resp.json().catch(() => ({}))) as
      | CompileArtifactResponse
      | { error: string; details?: string };

    if (!resp.ok) {
      const err = data as { error?: string; details?: string };
      throw new BadRequestException({
        message: err.error || 'Compilação falhou',
        details: err.details,
      });
    }

    return data as CompileArtifactResponse;
  }

  private getPublicBaseUrl(): string {
    const base = this.config.get<string>('IOT_ARTIFACTS_PUBLIC_BASE_URL');
    if (!base) {
      // Sem fallback hardcoded — URL de artefatos eh especifica do ambiente.
      // Configurar no .env (vide .env.example) antes de usar OTA.
      throw new InternalServerErrorException(
        'IOT_ARTIFACTS_PUBLIC_BASE_URL nao configurada no ambiente',
      );
    }
    return base.replace(/\/+$/, '');
  }
}
