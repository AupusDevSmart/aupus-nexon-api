import { Injectable } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { UpsertConfiguracaoCustoDto } from '../dto/configuracao-custo.dto';

export interface ConfiguracaoCustoData {
  icms: number;
  pis: number;
  cofins: number;
  perdas: number;
  usa_tarifa_personalizada: boolean;
  tusd_p: number | null;
  te_p: number | null;
  tusd_fp: number | null;
  te_fp: number | null;
  tusd_d: number | null;
  te_d: number | null;
  tusd_b: number | null;
  te_b: number | null;
}

@Injectable()
export class ConfiguracaoCustoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca configuracao de custo do equipamento.
   * Retorna defaults (tributos zerados, sem tarifa custom) se nao existir.
   */
  async buscarOuDefault(equipamentoId: string): Promise<ConfiguracaoCustoData> {
    const config = await this.prisma.configuracoes_custo_equipamento.findUnique({
      where: { equipamento_id: equipamentoId },
    });

    if (!config) {
      return {
        icms: 0,
        pis: 0,
        cofins: 0,
        perdas: 0,
        usa_tarifa_personalizada: false,
        tusd_p: null,
        te_p: null,
        tusd_fp: null,
        te_fp: null,
        tusd_d: null,
        te_d: null,
        tusd_b: null,
        te_b: null,
      };
    }

    return {
      icms: this.toNumber(config.icms),
      pis: this.toNumber(config.pis),
      cofins: this.toNumber(config.cofins),
      perdas: this.toNumber(config.perdas),
      usa_tarifa_personalizada: config.usa_tarifa_personalizada,
      tusd_p: this.toNumberOrNull(config.tusd_p),
      te_p: this.toNumberOrNull(config.te_p),
      tusd_fp: this.toNumberOrNull(config.tusd_fp),
      te_fp: this.toNumberOrNull(config.te_fp),
      tusd_d: this.toNumberOrNull(config.tusd_d),
      te_d: this.toNumberOrNull(config.te_d),
      tusd_b: this.toNumberOrNull(config.tusd_b),
      te_b: this.toNumberOrNull(config.te_b),
    };
  }

  /**
   * Cria ou atualiza configuracao de custo do equipamento
   */
  async upsert(
    equipamentoId: string,
    dto: UpsertConfiguracaoCustoDto,
  ): Promise<ConfiguracaoCustoData> {
    const data: any = {};

    if (dto.icms !== undefined) data.icms = dto.icms;
    if (dto.pis !== undefined) data.pis = dto.pis;
    if (dto.cofins !== undefined) data.cofins = dto.cofins;
    if (dto.perdas !== undefined) data.perdas = dto.perdas;
    if (dto.usa_tarifa_personalizada !== undefined)
      data.usa_tarifa_personalizada = dto.usa_tarifa_personalizada;
    if (dto.tusd_p !== undefined) data.tusd_p = dto.tusd_p;
    if (dto.te_p !== undefined) data.te_p = dto.te_p;
    if (dto.tusd_fp !== undefined) data.tusd_fp = dto.tusd_fp;
    if (dto.te_fp !== undefined) data.te_fp = dto.te_fp;
    if (dto.tusd_d !== undefined) data.tusd_d = dto.tusd_d;
    if (dto.te_d !== undefined) data.te_d = dto.te_d;
    if (dto.tusd_b !== undefined) data.tusd_b = dto.tusd_b;
    if (dto.te_b !== undefined) data.te_b = dto.te_b;

    await this.prisma.configuracoes_custo_equipamento.upsert({
      where: { equipamento_id: equipamentoId },
      create: {
        equipamento_id: equipamentoId,
        ...data,
      },
      update: data,
    });

    return this.buscarOuDefault(equipamentoId);
  }

  private toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    return parseFloat(value.toString());
  }

  private toNumberOrNull(value: any): number | null {
    if (value === null || value === undefined) return null;
    return parseFloat(value.toString());
  }
}
