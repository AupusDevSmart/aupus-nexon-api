import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, Cliente, ExportacaoAuditoriaService } from '@/core';
import type { ClienteInfo, ScopedUser } from '@/core';
import { linhasDoRelatorio, RelatoriosOperacaoService } from './relatorios-operacao.service';
import type { FormatoRelatorio } from './relatorios-operacao.tipos';

/** Usuário do JWT (id, papel) com o que a trilha de exportação registra. */
type UsuarioRelatorio = ScopedUser & { nome?: string | null; email?: string | null };

const FORMATOS: readonly FormatoRelatorio[] = ['tela', 'pdf', 'xlsx'];

/**
 * Relatórios de operação dos equipamentos (NEXON-33). O PDF e a planilha são gerados no
 * front com os mesmos dados; `formato` só vai para a trilha de exportação.
 * Escopo pelo PermissionScopeService (fora do escopo → 403, auditado como exportação negada).
 */
@Controller('relatorios/operacao')
@UseGuards(JwtAuthGuard)
export class RelatoriosOperacaoController {
  constructor(
    private readonly relatorios: RelatoriosOperacaoService,
    private readonly exportacoes: ExportacaoAuditoriaService,
  ) {}

  /** Instalações que têm equipamento do tipo do relatório (seletor da tela). */
  @Get('escopos')
  async escopos(@Query('tipo') tipo: string, @CurrentUser() user: UsuarioRelatorio, @Cliente() cliente?: ClienteInfo) {
    const t = this.relatorios.tipoValido(tipo);
    const data = await this.exportacoes.executar(
      { user, cliente, tipo: 'relatorio_operacao', extra: { relatorio: t, escopos: true } },
      () => this.relatorios.escopos(t, user),
      { registrarSucesso: false },
    );
    return { data };
  }

  @Get(':tipo')
  async relatorio(
    @Param('tipo') tipo: string,
    @Query('unidadeId') unidadeId: string,
    @Query('mes') mes: string,
    @Query('formato') formato: string,
    @CurrentUser() user: UsuarioRelatorio,
    @Cliente() cliente?: ClienteInfo,
  ) {
    const t = this.relatorios.tipoValido(tipo);
    const f: FormatoRelatorio = FORMATOS.includes(formato as FormatoRelatorio) ? (formato as FormatoRelatorio) : 'tela';
    const data = await this.exportacoes.executar(
      {
        user,
        cliente,
        tipo: 'relatorio_operacao',
        unidadeIds: [unidadeId],
        periodo: { mes: mes || null },
        formato: f,
        extra: { relatorio: t },
      },
      () => this.relatorios.gerar(t, unidadeId, mes, user),
      {
        // Abrir na tela não é exportação: só PDF/planilha gravam sucesso; recusa (403) grava sempre.
        registrarSucesso: f !== 'tela',
        resumo: (r) => ({
          linhas: linhasDoRelatorio(r),
          extra: { relatorio: t, chamados: r.chamados.length },
        }),
      },
    );
    return { data };
  }
}
