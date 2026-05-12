import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Resposta do acionamento de um ponto via mapeamento ton_bo.
 *
 * O pulso eh: r{N} on (com ack) -> wait pulso_ms -> r{N} off (fire-and-forget).
 * latency_ms cobre desde o publish do primeiro comando ate o ack do TON.
 */
export class AcionarPontoResultDto {
  @ApiProperty({ description: 'UUID gerado para o comando ON (correlaciona com ack do TON)' })
  cmd_id!: string;

  @ApiProperty({
    description:
      'Status do ack do TON ao comando ON. duplicate eh sucesso (TON ja havia executado).',
    enum: ['ok', 'duplicate'],
  })
  status!: 'ok' | 'duplicate';

  @ApiProperty({ description: 'Mensagem livre do TON sobre o comando ON', example: 'rele_3_on' })
  msg!: string;

  @ApiProperty({ description: 'Latencia ack do comando ON em ms', example: 234 })
  latency_ms!: number;

  @ApiProperty({ description: 'Duracao do pulso em ms entre ON e OFF', example: 500 })
  pulso_ms!: number;

  @ApiProperty({ description: 'Comando tecnico publicado no broker', example: 'r3 on -> r3 off' })
  comando_tecnico!: string;

  @ApiProperty({
    description: 'Descricao semantica do que foi acionado (equipamento + ponto)',
    example: 'Disjuntor SE-04 · abrir',
  })
  comando_semantico!: string;

  @ApiPropertyOptional({ description: 'Numero do BO (1..6) executado', example: 3 })
  bo_numero?: number;
}
