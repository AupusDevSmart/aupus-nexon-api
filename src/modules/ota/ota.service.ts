import { randomBytes } from 'crypto';
import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core';
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

/** Estados do acompanhamento (tabela ota_execucoes). */
export type EstadoOta = 'publicado' | 'baixando' | 'reiniciando' | 'confirmado' | 'falhou' | 'sem_resposta';
const ESTADOS_ABERTOS: EstadoOta[] = ['publicado', 'baixando', 'reiniciando'];
/** Sem confirmação em 15 min (download + reboot + reconexão com folga) → sem_resposta. */
const TIMEOUT_OTA_MS = 15 * 60_000;

/** `#define FIRMWARE_VERSION "1.8.0-build202610261530"` dos arquivos gerados — é o que a TON anuncia. */
export function versaoDoFirmware(files: Record<string, string> | undefined): string | null {
  for (const conteudo of Object.values(files ?? {})) {
    const m = typeof conteudo === 'string' ? /#define\s+FIRMWARE_VERSION\s+"([^"]+)"/.exec(conteudo) : null;
    if (m) return m[1];
  }
  return null;
}

@Injectable()
export class OtaService implements OnModuleInit {
  private readonly logger = new Logger(OtaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.mqtt.setOtaHooks({
      otaStatus: (topic, dados) => void this.aoStatusOta(topic, dados).catch((e) => this.logger.warn(`ota/status: ${(e as Error).message}`)),
      tonStatus: (eqId, dados) => void this.aoAnuncioTon(eqId, dados).catch((e) => this.logger.warn(`status TON: ${(e as Error).message}`)),
    });
  }

  private novoId(): string {
    return (Date.now().toString(36) + randomBytes(12).toString('hex')).slice(0, 26).padEnd(26, '0');
  }

  /** Registra o OTA disparado (estado 'publicado'). Falha aqui não impede o OTA. */
  private async registrarExecucao(eqId: string, topicoBase: string, dados: {
    versaoFirmware: string | null; versaoComando: string; url: string; md5?: string; tamanho?: number;
  }): Promise<string | null> {
    try {
      const id = this.novoId();
      const ant = await this.prisma.$queryRaw<Array<{ v: string | null }>>`
        SELECT firmware_versao AS v FROM iot_dispositivos_online WHERE topico_mqtt = ${topicoBase} LIMIT 1`;
      // Um OTA por TON: o anterior que ainda estiver aberto é encerrado como substituído.
      await this.prisma.$executeRaw`
        UPDATE ota_execucoes SET estado = 'falhou', detalhe = 'substituído por novo OTA', concluido_em = now(), atualizado_em = now()
        WHERE equipamento_id = ${eqId}::bpchar AND estado IN ('publicado', 'baixando', 'reiniciando')`;
      await this.prisma.$executeRaw`
        INSERT INTO ota_execucoes (id, equipamento_id, topico, versao_firmware, versao_comando, versao_anterior, url, md5, tamanho)
        VALUES (${id}, ${eqId}::bpchar, ${topicoBase}, ${dados.versaoFirmware}, ${dados.versaoComando}, ${ant[0]?.v ?? null},
                ${dados.url}, ${dados.md5 ?? null}, ${dados.tamanho ?? null})`;
      return id;
    } catch (e) {
      this.logger.warn(`Não registrou acompanhamento do OTA: ${(e as Error).message}`);
      return null;
    }
  }

  /** <base>/ota/status: downloading (progress) / success / error / refused / skipped. */
  private async aoStatusOta(topic: string, dados: any): Promise<void> {
    const base = topic.replace(/\/ota\/status$/, '');
    const state = String(dados?.state ?? '');
    const pct = Number.isFinite(Number(dados?.progress)) ? Math.max(0, Math.min(100, Math.round(Number(dados.progress)))) : null;
    const msg = dados?.msg != null ? String(dados.msg).slice(0, 300) : null;
    let estado: EstadoOta | null = null;
    if (state === 'downloading') estado = 'baixando';
    else if (state === 'success') estado = 'reiniciando';
    else if (state === 'error' || state === 'refused') estado = 'falhou';
    else if (state === 'skipped') estado = 'confirmado'; // já estava nesta versão
    if (!estado) return;
    const terminal = estado === 'falhou' || estado === 'confirmado';
    await this.prisma.$executeRaw`
      UPDATE ota_execucoes SET estado = ${estado},
        progresso = COALESCE(${estado === 'reiniciando' ? 100 : pct}, progresso),
        detalhe = CASE WHEN ${estado} = 'baixando' THEN detalhe ELSE COALESCE(${msg}, detalhe) END,
        concluido_em = CASE WHEN ${terminal} THEN now() ELSE concluido_em END,
        atualizado_em = now()
      WHERE id = (SELECT id FROM ota_execucoes WHERE topico = ${base} AND estado IN ('publicado', 'baixando', 'reiniciando')
                  ORDER BY criado_em DESC LIMIT 1)`;
  }

  /**
   * Anúncio AO VIVO de <base>/status: a TON voltou. Versão igual à do binário → confirmado.
   * Versão diferente depois de 'reiniciando' → falhou (rollback do bootloader ou gravação não pegou).
   * Antes do download (publicado/baixando) uma reconexão com a versão antiga é normal: ignora.
   */
  private async aoAnuncioTon(eqId: string, dados: any): Promise<void> {
    const versao = dados?.version != null ? String(dados.version) : null;
    if (!versao) return;
    const abertos = await this.prisma.$queryRaw<Array<{ id: string; estado: string; versao_firmware: string | null }>>`
      SELECT id, estado, versao_firmware FROM ota_execucoes
      WHERE equipamento_id = ${eqId.trim()}::bpchar AND estado IN ('publicado', 'baixando', 'reiniciando')
      ORDER BY criado_em DESC LIMIT 1`;
    const ex = abertos[0];
    if (!ex) return;
    if (ex.versao_firmware && versao === ex.versao_firmware) {
      await this.prisma.$executeRaw`
        UPDATE ota_execucoes SET estado = 'confirmado', progresso = 100, detalhe = ${`rodando ${versao}`},
          concluido_em = now(), atualizado_em = now() WHERE id = ${ex.id.trim()}::bpchar`;
      this.logger.log(`OTA confirmado: ${eqId.trim()} rodando ${versao}`);
    } else if (!ex.versao_firmware && ex.estado === 'reiniciando') {
      // OTA sem a versão do binário (rota "publicar" com .bin pronto): voltou depois de gravar.
      await this.prisma.$executeRaw`
        UPDATE ota_execucoes SET estado = 'confirmado', progresso = 100,
          detalhe = ${`voltou rodando ${versao} (versão esperada desconhecida)`},
          concluido_em = now(), atualizado_em = now() WHERE id = ${ex.id.trim()}::bpchar`;
    } else if (ex.estado === 'reiniciando') {
      await this.prisma.$executeRaw`
        UPDATE ota_execucoes SET estado = 'falhou', detalhe = ${`voltou com a versão ${versao} (esperada ${ex.versao_firmware ?? '?'}) — rollback?`},
          concluido_em = now(), atualizado_em = now() WHERE id = ${ex.id.trim()}::bpchar`;
    }
  }

  /** Último OTA da TON (para a tela acompanhar). Aberto há mais de 15 min → sem_resposta. */
  async ultimaExecucao(equipamentoId: string) {
    const eqId = equipamentoId.trim();
    await this.prisma.$executeRaw`
      UPDATE ota_execucoes SET estado = 'sem_resposta', detalhe = COALESCE(detalhe, 'TON não confirmou em 15 min'),
        concluido_em = now(), atualizado_em = now()
      WHERE equipamento_id = ${eqId}::bpchar AND estado IN ('publicado', 'baixando', 'reiniciando')
        AND criado_em < now() - make_interval(secs => ${TIMEOUT_OTA_MS / 1000}::int)`;
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT id, estado, progresso, detalhe, versao_firmware, versao_anterior, md5, tamanho,
             criado_em, atualizado_em, concluido_em
      FROM ota_execucoes WHERE equipamento_id = ${eqId}::bpchar ORDER BY criado_em DESC LIMIT 1`;
    return { execucao: rows[0] ?? null, abertos: ESTADOS_ABERTOS };
  }

  /**
   * Publica um comando OTA para um equipamento específico.
   * Requer que o equipamento tenha topico_mqtt configurado.
   */
  async triggerOta(
    equipamentoId: string,
    dto: TriggerOtaDto,
    acompanhamento?: { versaoFirmware: string | null; tamanho?: number },
  ): Promise<OtaStatusResponseDto & { execucao_id?: string | null; versao_firmware?: string | null }> {
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

    const execucaoId = await this.registrarExecucao(equipamento.id.trim(), topicBase, {
      versaoFirmware: acompanhamento?.versaoFirmware ?? null,
      versaoComando: dto.version,
      url: dto.url,
      md5: dto.md5,
      tamanho: acompanhamento?.tamanho,
    });

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
      execucao_id: execucaoId,
      versao_firmware: acompanhamento?.versaoFirmware ?? null,
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
    }, { versaoFirmware: versaoDoFirmware(dto.files as Record<string, string>), tamanho: artifact.size });

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
