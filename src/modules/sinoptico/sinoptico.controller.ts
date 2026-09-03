import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '@/core';
import { SinopticoService } from './sinoptico.service';

@Controller('sinoptico')
export class SinopticoController {
  constructor(private readonly service: SinopticoService) {}

  /**
   * Status da unidade para o cabecalho do sinoptico (R1).
   * janelaAlarmesMinutos: janela para contar alarmes ativos (default 60).
   * limiteStalenessMinutos: limite sem dados que indica falha (default 30).
   */
  @Get('unidade/:unidadeId/status')
  getStatus(
    @Param('unidadeId') unidadeId: string,
    @Query('janelaAlarmesMinutos') janelaAlarmesMinutos?: string,
    @Query('limiteStalenessMinutos') limiteStalenessMinutos?: string,
    @CurrentUser() user?: any,
  ) {
    return this.service.getStatus(
      unidadeId,
      {
        janelaAlarmesMinutos: janelaAlarmesMinutos ? Number(janelaAlarmesMinutos) : undefined,
        limiteStalenessMinutos: limiteStalenessMinutos ? Number(limiteStalenessMinutos) : undefined,
      },
      user,
    );
  }
}
