import { ApiProperty } from '@nestjs/swagger';

/**
 * Resposta canonica do POST /equipamentos/:id/cmd.
 *
 * Espelha CmdAckResult do MqttService.publishCommand, mais latency_ms
 * para observabilidade (medido entre publish e recebimento do ack).
 *
 * NexOn axios interceptor desempacota automaticamente — frontend recebe
 * o shape direto em resp.data (sem .data.data).
 *
 * Mapeamento para HTTP:
 *   status='ok' ou 'duplicate' -> 200 com este body
 *   status='error'             -> 502 com envelope de erro NexOn
 *   timeout do publishCommand  -> 504 com envelope de erro NexOn
 */
export class CommandResultDto {
  @ApiProperty({
    description: 'UUID gerado para correlacionar comando com ack do TON',
    example: 'a3b1c2d4-e5f6-0718-2930-415263748596',
  })
  cmd_id!: string;

  @ApiProperty({
    description: 'Status reportado pelo TON. duplicate eh tratado como sucesso (TON ja havia executado).',
    enum: ['ok', 'duplicate'],
    example: 'ok',
  })
  status!: 'ok' | 'duplicate';

  @ApiProperty({
    description: 'Mensagem livre do TON (ex: "rele_1_on", "executado", etc.)',
    example: 'rele_1_on',
  })
  msg!: string;

  @ApiProperty({
    description: 'Timestamp Unix em segundos do TON quando processou o comando',
    example: 1735000000,
  })
  ts!: number;

  @ApiProperty({
    description: 'Latencia em ms entre publish do backend e recebimento do ack',
    example: 234,
  })
  latency_ms!: number;
}
