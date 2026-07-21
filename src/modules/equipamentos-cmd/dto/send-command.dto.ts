import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, ValidateIf, IsString, IsObject, MaxLength, IsOptional, IsBoolean, Matches } from 'class-validator';

/**
 * Payload de comando para POST /equipamentos/:id/cmd.
 *
 * O TON aceita 2 formatos no campo `cmd`:
 *  - String simples: "r1 on", "tr2 off", "status" (atalhos firmware)
 *  - Objeto estruturado: { device: "Inversor", cmd: "cmd_fechar" } (Modbus BO)
 *
 * Backend nao valida semanticamente — repassa cru para publishCommand.
 * Firmware responde {status:"error", msg:"..."} se receber comando invalido,
 * que mapeia para HTTP 502 com envelope de erro NexOn.
 *
 * Decisao consciente (PR2): acomoda extensao futura sem mudanca de contrato.
 * Quando a tabela tipos_equipamentos.mqtt_schema for populada com schema de
 * comandos por tipo, podemos validar aqui antes de publicar.
 */
export class SendCommandDto {
  @ApiProperty({
    description:
      'Comando a publicar em <topico_mqtt>/cmd. String para atalhos firmware ' +
      '(r1-r6 on/off na v1, r1-r8 e pwm1-8 <0-100> na TON-V2, tr1-tr4 on/off, ' +
      'status) ou objeto para Modbus BO ({device, cmd}). Tamanho max 1KB.',
    examples: {
      rele: { value: 'r1 on', summary: 'Liga rele 1' },
      transistor: { value: 'tr2 off', summary: 'Desliga transistor 2' },
      modbus: {
        value: { device: 'Inversor', cmd: 'cmd_fechar' },
        summary: 'Comando Modbus BO direcionado a um device',
      },
      debug: { value: 'status', summary: 'Imprime estado dos I/O no Serial Monitor' },
    },
    oneOf: [
      { type: 'string', maxLength: 1024 },
      { type: 'object', additionalProperties: true },
    ],
  })
  @IsDefined({ message: 'cmd e obrigatorio' })
  @ValidateIf((_, v) => typeof v === 'string')
  @IsString()
  @MaxLength(1024, { message: 'cmd string max 1024 chars' })
  @ValidateIf((_, v) => typeof v === 'object' && v !== null)
  @IsObject()
  cmd!: string | Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Modo SIMULACAO/LAB: quando true, publica em TESTE/<topico_mqtt>/cmd (onde o ' +
      'firmware de simulacao escuta) em vez do topico real, e aguarda o ack em ' +
      'TESTE/<topico_mqtt>/cmd/ack. Usado pelo painel de comando do diagrama IoT ' +
      'em modo Simular — testa o pipeline sem tocar o equipamento de producao.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sim?: boolean;

  /**
   * Só vale com sim=true. MAC do board de BANCADA que faz o papel do equipamento
   * nesta sessão de teste (remap). Reescreve .../satellite/<MAC-cadastrado> ->
   * .../satellite/<testMac> só no tópico TESTE/, sem tocar no cadastro. MAC
   * distinto do de campo => nunca aciona o equipamento real.
   */
  @ApiPropertyOptional({
    description:
      'SIM only: MAC do board de bancada (remap). Ex.: "28:37:2F:9D:8D:80".',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/, {
    message: 'testMac deve ser um MAC válido (AA:BB:CC:DD:EE:FF)',
  })
  testMac?: string;
}
