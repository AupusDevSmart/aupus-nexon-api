import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { camposDoStatusPivo, ehPivo, papelStatusPivo, type StatusPivo } from './leitura-vinculada';

@Injectable()
export class EquipamentosDataService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtém o dado mais recente de um equipamento
   */
  async obterDadoAtual(equipamentoId: string) {
    // Verificar se o equipamento existe e buscar informações dele
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
      include: {
        tipo_equipamento_rel: true,
      },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Última leitura (cadência varia: TON ~1s, A966 ~15min). O consumidor decide
    // se está stale via timestamp_dados; o índice (equipamento_id, timestamp_dados desc)
    // resolve a busca sem full scan.
    const ultimoDado = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: equipamentoId },
      orderBy: { timestamp_dados: 'desc' },
    });

    if (!ultimoDado) {
      const vinculada = await this.leituraVinculada(equipamento.id, equipamento.tipo_equipamento_rel?.nome);
      if (vinculada) return this.formatDadoResponse(equipamento, vinculada);
      // Retornar estrutura com equipamento mas sem dado
      return {
        equipamento: {
          id: equipamento.id,
          nome: equipamento.nome,
          tipo: equipamento.tipo_equipamento_rel?.nome || equipamento.tipo_equipamento,
          mqtt_habilitado: equipamento.mqtt_habilitado,
          topico_mqtt: equipamento.topico_mqtt,
        },
        dado: null,
        message: 'Nenhum dado MQTT disponível para este equipamento',
      };
    }

    return this.formatDadoResponse(equipamento, ultimoDado);
  }

  /**
   * Equipamento sem leitura própria: quem publica é o device vinculado no IoT. Mesma resolução do
   * web (power-meter-by-disjuntor), limitada à instalação do equipamento. Pivô soma o status das
   * entradas da TON, como /pivos/:id/estado, para os apps já publicados que só leem esta rota.
   * Só com status (sem medidor) vai sem timestamp, e só com a TON online: TON fora devolve null
   * e o app segue em "Sem comunicação".
   */
  private async leituraVinculada(id: string, tipo?: string | null) {
    const eid = id.trim();
    const fontes = await this.prisma.$queryRaw<Array<{ fonte: string }>>`
      SELECT src.id AS fonte
      FROM iot_componentes c
      JOIN equipamentos alvo ON alvo.id = ${eid}::bpchar AND alvo.deleted_at IS NULL
      JOIN equipamentos src ON src.id = TRIM(c.props->>'equipamento_id')::bpchar
        AND src.deleted_at IS NULL AND src.unidade_id = alvo.unidade_id
      WHERE c.props->>'disjuntor_equipamento_id' = ${eid}
         OR (jsonb_typeof(c.props->'elementos_extra') = 'array' AND c.props->'elementos_extra' ? ${eid})
      ORDER BY (c.props->>'disjuntor_equipamento_id' = ${eid}) DESC, c.id
      LIMIT 1`;
    const medidor = fontes[0]
      ? await this.prisma.equipamentos_dados.findFirst({
          where: { equipamento_id: fontes[0].fonte },
          orderBy: { timestamp_dados: 'desc' },
        })
      : null;
    const status = ehPivo(tipo) ? await this.statusPivoDaTon(eid) : null;
    if (!medidor && !status) return null;
    return {
      id: medidor?.id ?? null,
      dados: { ...((medidor?.dados as object) ?? {}), ...(status ?? {}) },
      fonte: medidor?.fonte ?? null,
      timestamp_dados: medidor?.timestamp_dados ?? null,
      qualidade: medidor?.qualidade ?? null,
      created_at: medidor?.created_at ?? null,
    };
  }

  /** Campos do status do pivô, ou null sem entrada vinculada ou com a TON offline. */
  private async statusPivoDaTon(id: string): Promise<Record<string, unknown> | null> {
    const pontos = await this.prisma.$queryRaw<Array<{ nome: string; inv: boolean; valor: string | null; online: boolean }>>`
      SELECT p.nome, b.invertido AS inv, io.inputs->>('d' || b.bi_numero::text) AS valor,
             EXISTS (
               SELECT 1 FROM equipamentos t
               JOIN iot_dispositivos_online d
                 ON TRIM(t.topico_mqtt) = TRIM(d.topico_mqtt) OR starts_with(TRIM(t.topico_mqtt), TRIM(d.topico_mqtt) || '/')
               WHERE t.id = b.ton_id AND d.online = true AND d.last_seen > now() - interval '15 minutes'
             ) AS online
      FROM equipamento_pontos p
      JOIN ton_bi b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      LEFT JOIN equipamento_io_estado io ON io.equipamento_id = b.ton_id
      WHERE p.equipamento_id = ${id}::bpchar AND p.tipo = 'status' AND p.deleted_at IS NULL AND p.ativo`;
    if (!pontos.some((p) => p.online)) return null;
    const st: StatusPivo = {};
    for (const p of pontos) {
      const papel = papelStatusPivo(p.nome);
      if (!papel || st[papel] != null) continue;
      if (p.valor === null) { st[papel] = null; continue; }
      const v = Number(p.valor) ? 1 : 0;
      st[papel] = (p.inv ? 1 - v : v) as 0 | 1;
    }
    const campos = camposDoStatusPivo(st);
    return Object.keys(campos).length ? campos : null;
  }

  /**
   * Obtém histórico de dados de um equipamento
   */
  async obterHistorico(
    equipamentoId: string,
    options: {
      inicio?: Date;
      fim?: Date;
      limite?: number;
      intervalo?: 'raw' | '1min' | '5min' | '1hour' | '1day';
    },
  ) {
    const { inicio, fim, limite = 100, intervalo = 'raw' } = options;

    // Verificar se o equipamento existe
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Construir filtro de datas
    const whereClause: any = {
      equipamento_id: equipamentoId,
    };

    if (inicio || fim) {
      whereClause.timestamp_dados = {};
      if (inicio) whereClause.timestamp_dados.gte = inicio;
      if (fim) whereClause.timestamp_dados.lte = fim;
    }

    // Buscar dados
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: whereClause,
      orderBy: { timestamp_dados: 'desc' },
      take: limite,
    });

    // TODO: Implementar agrupamento por intervalo
    // Por enquanto retorna raw data
    const dadosFormatados = dados.map((dado) => ({
      id: dado.id,
      timestamp_dados: dado.timestamp_dados,
      dados: dado.dados,
      qualidade: dado.qualidade,
      fonte: dado.fonte,
      created_at: dado.created_at,
    }));

    return {
      data: dadosFormatados,
      pagination: {
        page: 1,
        limit: limite,
        total: dadosFormatados.length,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
  }

  /**
   * Formata resposta de um dado
   */
  private formatDadoResponse(equipamento: any, dado: any) {
    return {
      equipamento: {
        id: equipamento.id,
        nome: equipamento.nome,
        tipo: equipamento.tipo_equipamento_rel?.nome || equipamento.tipo_equipamento,
        mqtt_habilitado: equipamento.mqtt_habilitado,
        topico_mqtt: equipamento.topico_mqtt,
      },
      dado: {
        id: dado.id,
        dados: dado.dados,
        fonte: dado.fonte,
        timestamp_dados: dado.timestamp_dados,
        qualidade: dado.qualidade,
        created_at: dado.created_at,
      },
    };
  }
}
