import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@aupus/api-shared';
import { BoletimConsumoEnvioService } from './boletim-consumo-envio.service';
import { BoletimConsumoService } from './boletim-consumo.service';
import { RelatoriosService } from './relatorios.service';

/**
 * Endpoint PÚBLICO do PDF do relatório de consumo (SEM JwtAuthGuard — controller separado
 * do autenticado, senão o @UseGuards de classe barraria). O token HMAC assinado É a
 * autorização — link enviado por WhatsApp ao dono (que não tem login). Espelha
 * [[relatorios-publico.controller]].
 */
@Controller('relatorios/consumo')
export class RelatoriosConsumoPublicController {
  constructor(
    private readonly envio: BoletimConsumoEnvioService,
    private readonly consumo: BoletimConsumoService,
    private readonly gerador: RelatoriosService,
  ) {}

  @Public()
  @Get('pdf')
  async pdf(@Query('token') token: string, @Res() res: Response) {
    const v = this.envio.verifyToken(token || '');
    if (!v) {
      res.status(403).send('Link inválido ou expirado.');
      return;
    }
    try {
      const dados = await this.consumo.montarPayload(v.u, v.d || undefined); // sem user → token é a auth
      const pdf = await this.gerador.gerarPdfConsumo(dados);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="relatorio-consumo.pdf"');
      res.send(pdf);
    } catch (e: any) {
      res.status(500).send('Não foi possível gerar o relatório de consumo.');
    }
  }
}
