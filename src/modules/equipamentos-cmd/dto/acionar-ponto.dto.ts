import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsString, Matches } from 'class-validator';

/**
 * Body opcional do POST /equipamentos/:id/pontos/:pontoId/acionar.
 *
 * Sem body (Unifilar/operação real): aciona no tópico real do equipamento.
 * Com { sim: true } (painel de teste do diagrama IoT em modo Simular): faz o
 * mesmo pulso ON->OFF, mas no tópico TESTE/<topico>/cmd, onde o firmware de
 * simulação escuta — testa o pipeline de comando ponta a ponta sem tocar o
 * equipamento de produção.
 */
export class AcionarPontoDto {
  @ApiPropertyOptional({
    description:
      'Modo SIMULAÇÃO/LAB: executa o pulso em TESTE/<topico>/cmd (firmware de ' +
      'simulação) em vez do tópico real. Default false (operação real).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sim?: boolean;

  /**
   * Só vale com sim=true. MAC do board de BANCADA que faz o papel da TON nesta
   * sessão de teste (remap). Quando presente, o backend reescreve o segmento
   * .../satellite/<MAC-cadastrado> -> .../satellite/<testMac> no tópico TESTE/,
   * roteando o comando pro board físico de bancada. O cadastro de produção fica
   * intocado, e como o MAC é DISTINTO do de campo, nunca aciona o board real.
   */
  @ApiPropertyOptional({
    description:
      'SIM only: MAC do board de bancada (remap). Reescreve /satellite/<MAC> -> ' +
      '/satellite/<testMac> só no TESTE/. Ex.: "28:37:2F:9D:8D:80".',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/, {
    message: 'testMac deve ser um MAC válido (AA:BB:CC:DD:EE:FF)',
  })
  testMac?: string;
}
