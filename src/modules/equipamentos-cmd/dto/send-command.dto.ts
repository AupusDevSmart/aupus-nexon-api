import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, ValidateIf, IsString, IsObject, MaxLength } from 'class-validator';

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
      '(r1-r6 on/off, tr1-tr4 on/off, status) ou objeto para Modbus BO ' +
      '({device, cmd}). Tamanho max 1KB para evitar abuso.',
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
}
