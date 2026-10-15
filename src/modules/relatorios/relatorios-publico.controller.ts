import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, ExportacaoAuditoriaService, extrairClienteInfo } from '@/core';
import { BoletimSemanalEnvioService } from './boletim-semanal-envio.service';
import { BoletimSemanalService } from './boletim-semanal.service';
import { RelatoriosService } from './relatorios.service';

/**
 * Endpoint PÚBLICO do PDF do boletim (SEM JwtAuthGuard). O token HMAC assinado É a
 * autorização — usado no link enviado por WhatsApp ao dono da usina (que não tem login).
 */
@Controller('relatorios/semanal')
export class RelatoriosPublicController {
  constructor(
    private readonly envio: BoletimSemanalEnvioService,
    private readonly boletim: BoletimSemanalService,
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
        { cliente, tipo: 'boletim_semanal', via: 'link_assinado', formato: 'pdf' },
        'link inválido ou expirado',
      );
      res.status(403).send('Link inválido ou expirado.');
      return;
    }
    try {
      const dados = await this.boletim.montarPayload(v.u, v.d || undefined); // sem user → token é a auth
      const pdf = await this.gerador.gerarPdf(dados);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="boletim-semanal.pdf"');
      res.send(pdf);
      await this.exportacoes.registrar({
        cliente,
        tipo: 'boletim_semanal',
        via: 'link_assinado',
        unidadeIds: [v.u],
        periodo: { data: v.d || null },
        formato: 'pdf',
      });
    } catch (e: any) {
      res.status(500).send('Não foi possível gerar o boletim.');
    }
  }
}
