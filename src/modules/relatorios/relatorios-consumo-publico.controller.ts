import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, ExportacaoAuditoriaService, extrairClienteInfo } from '@/core';
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
    private readonly exportacoes: ExportacaoAuditoriaService,
  ) {}

  @Public()
  @Get('pdf')
  async pdf(@Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    const cliente = extrairClienteInfo(req as any);
    const v = this.envio.verifyToken(token || '');
    if (!v) {
      await this.exportacoes.negada(
        { cliente, tipo: 'consumo', via: 'link_assinado', formato: 'pdf' },
        'link inválido ou expirado',
      );
      res.status(403).send('Link inválido ou expirado.');
      return;
    }
    try {
      const dados = await this.consumo.montarPayload(v.u, v.d || undefined); // sem user → token é a auth
      const pdf = await this.gerador.gerarPdfConsumo(dados);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="relatorio-consumo.pdf"');
      res.send(pdf);
      await this.exportacoes.registrar({
        cliente,
        tipo: 'consumo',
        via: 'link_assinado',
        unidadeIds: [v.u],
        periodo: { data: v.d || null },
        formato: 'pdf',
      });
    } catch (e: any) {
      res.status(500).send('Não foi possível gerar o relatório de consumo.');
    }
  }
}
