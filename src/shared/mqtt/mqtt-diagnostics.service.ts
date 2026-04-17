import { Injectable } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';

@Injectable()
export class MqttDiagnosticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Diagnóstico completo do sistema MQTT
   */
  async getFullDiagnostics() {
    const [
      equipamentos,
      stats,
      qualidade,
      topicos,
      gaps,
      ultimos
    ] = await Promise.all([
      this.getEquipamentosStatus(),
      this.getStats(),
      this.getQualidadeAnalise(),
      this.getTopicosStatus(),
      this.getGaps(),
      this.getUltimosRegistros()
    ]);

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalEquipamentosConfigurados: equipamentos.configurados,
        equipamentosAtivos24h: equipamentos.ativos,
        equipamentosInativos: equipamentos.countInativos,
        totalRegistros24h: stats.totalRegistros,
        ultimoRegistro: stats.ultimoRegistro,
        qualidadeBoa: qualidade.find(q => q.qualidade === 'boa')?.percentual || 0,
        qualidadeRuim: qualidade.find(q => q.qualidade === 'ruim')?.percentual || 0,
        gapsDetectados: gaps.length,
      },
      equipamentos,
      stats,
      qualidade,
      topicos,
      gaps,
      ultimos
    };
  }

  /**
   * Status resumido
   */
  async getStatus() {
    const stats = await this.getStats();
    const equipamentos = await this.getEquipamentosStatus();

    const agora = new Date();
    const ultimoRegistro = stats.ultimoRegistro ? new Date(stats.ultimoRegistro) : null;
    const minutosSemDados = ultimoRegistro
      ? Math.floor((agora.getTime() - ultimoRegistro.getTime()) / (1000 * 60))
      : null;

    let status: 'ok' | 'warning' | 'critical' = 'ok';
    let mensagem = 'Sistema operando normalmente';

    if (!ultimoRegistro || minutosSemDados === null) {
      status = 'critical';
      mensagem = 'Nenhum dado recebido nas últimas 24h';
    } else if (minutosSemDados > 60) {
      status = 'critical';
      mensagem = `Sem dados há ${Math.floor(minutosSemDados / 60)}h ${minutosSemDados % 60}min`;
    } else if (minutosSemDados > 15) {
      status = 'warning';
      mensagem = `Sem dados há ${minutosSemDados} minutos`;
    }

    return {
      status,
      mensagem,
      timestamp: agora.toISOString(),
      equipamentosAtivos: equipamentos.ativos,
      equipamentosConfigurados: equipamentos.configurados,
      ultimoRegistro: ultimoRegistro?.toISOString() || null,
      minutosSemDados
    };
  }

  /**
   * Status dos equipamentos
   */
  async getEquipamentosStatus() {
    const funcionando = await this.prisma.$queryRaw<any[]>`
      SELECT
        e.id,
        e.nome,
        e.tag,
        e.topico_mqtt,
        te.codigo as tipo_equipamento,
        u.nome as unidade,
        COUNT(ed.id) as registros_24h,
        MAX(ed.timestamp_dados) as ultima_recepcao,
        ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(ed.timestamp_dados)))/3600, 2) as horas_desde_ultimo,
        MAX(ed.qualidade) as ultima_qualidade
      FROM equipamentos e
      JOIN equipamentos_dados ed ON e.id = ed.equipamento_id
      LEFT JOIN tipos_equipamentos te ON e.tipo_equipamento_id = te.id
      LEFT JOIN unidades u ON e.unidade_id = u.id
      WHERE ed.timestamp_dados >= NOW() - INTERVAL '24 hours'
      GROUP BY e.id, e.nome, e.tag, e.topico_mqtt, te.codigo, u.nome
      ORDER BY registros_24h DESC
    `;

    const inativos = await this.prisma.$queryRaw<any[]>`
      SELECT
        e.id,
        e.nome,
        e.tag,
        e.topico_mqtt,
        te.codigo as tipo_equipamento,
        u.nome as unidade,
        MAX(ed.timestamp_dados) as ultima_recepcao_conhecida,
        CASE
          WHEN MAX(ed.timestamp_dados) IS NULL THEN 'Nunca recebeu dados'
          ELSE CONCAT('Há ', ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(ed.timestamp_dados)))/86400), ' dias')
        END as status_inatividade
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos te ON e.tipo_equipamento_id = te.id
      LEFT JOIN unidades u ON e.unidade_id = u.id
      LEFT JOIN equipamentos_dados ed ON e.id = ed.equipamento_id
      WHERE e.mqtt_habilitado = true
        AND e.topico_mqtt IS NOT NULL
        AND e.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM equipamentos_dados ed2
          WHERE ed2.equipamento_id = e.id
          AND ed2.timestamp_dados >= NOW() - INTERVAL '24 hours'
        )
      GROUP BY e.id, e.nome, e.tag, e.topico_mqtt, te.codigo, u.nome
      ORDER BY ultima_recepcao_conhecida DESC NULLS LAST
    `;

    return {
      configurados: funcionando.length + inativos.length,
      ativos: funcionando.length,
      countInativos: inativos.length,
      funcionando: funcionando.map(eq => ({
        ...eq,
        ultima_recepcao: eq.ultima_recepcao?.toISOString(),
        registros_24h: Number(eq.registros_24h)
      })),
      inativos: inativos.map(eq => ({
        ...eq,
        ultima_recepcao_conhecida: eq.ultima_recepcao_conhecida?.toISOString()
      }))
    };
  }

  /**
   * Estatísticas gerais
   */
  async getStats() {
    const stats = await this.prisma.$queryRaw<any[]>`
      SELECT
        COUNT(DISTINCT equipamento_id) as equipamentos_ativos,
        COUNT(*) as total_registros,
        MIN(timestamp_dados) as primeiro_registro,
        MAX(timestamp_dados) as ultimo_registro,
        ROUND(AVG(num_leituras), 2) as media_leituras_por_registro
      FROM equipamentos_dados
      WHERE timestamp_dados >= NOW() - INTERVAL '24 hours'
    `;

    return {
      equipamentosAtivos: Number(stats[0]?.equipamentos_ativos || 0),
      totalRegistros: Number(stats[0]?.total_registros || 0),
      primeiroRegistro: stats[0]?.primeiro_registro?.toISOString() || null,
      ultimoRegistro: stats[0]?.ultimo_registro?.toISOString() || null,
      mediaLeiturasPorRegistro: Number(stats[0]?.media_leituras_por_registro || 0)
    };
  }

  /**
   * Análise de qualidade
   */
  async getQualidadeAnalise() {
    const qualidade = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(qualidade, 'null') as qualidade,
        COUNT(*) as registros,
        COUNT(DISTINCT equipamento_id) as equipamentos,
        ROUND(COUNT(*)::NUMERIC / (SELECT COUNT(*) FROM equipamentos_dados WHERE timestamp_dados >= NOW() - INTERVAL '24 hours') * 100, 2) as percentual
      FROM equipamentos_dados
      WHERE timestamp_dados >= NOW() - INTERVAL '24 hours'
      GROUP BY qualidade
      ORDER BY registros DESC
    `;

    return qualidade.map(q => ({
      ...q,
      registros: Number(q.registros),
      equipamentos: Number(q.equipamentos),
      percentual: Number(q.percentual)
    }));
  }

  /**
   * Status dos tópicos
   */
  async getTopicosStatus() {
    const topicos = await this.prisma.$queryRaw<any[]>`
      SELECT
        e.topico_mqtt,
        COUNT(DISTINCT e.id) as quantidade_equipamentos,
        COUNT(DISTINCT ed.equipamento_id) FILTER (WHERE ed.timestamp_dados >= NOW() - INTERVAL '24 hours') as equipamentos_ativos_24h,
        MAX(ed.timestamp_dados) as ultima_recepcao
      FROM equipamentos e
      LEFT JOIN equipamentos_dados ed ON e.id = ed.equipamento_id
      WHERE e.mqtt_habilitado = true
        AND e.topico_mqtt IS NOT NULL
        AND e.deleted_at IS NULL
      GROUP BY e.topico_mqtt
      ORDER BY equipamentos_ativos_24h DESC, quantidade_equipamentos DESC
    `;

    return topicos.map(t => ({
      topico: t.topico_mqtt,
      quantidadeEquipamentos: Number(t.quantidade_equipamentos),
      equipamentosAtivos24h: Number(t.equipamentos_ativos_24h),
      ultimaRecepcao: t.ultima_recepcao?.toISOString() || null,
      status: Number(t.equipamentos_ativos_24h) > 0 ? 'ativo' : 'inativo'
    }));
  }

  /**
   * Gaps de dados
   */
  async getGaps() {
    const gaps = await this.prisma.$queryRaw<any[]>`
      WITH dados_timeline AS (
        SELECT
          equipamento_id,
          timestamp_dados,
          LAG(timestamp_dados) OVER (PARTITION BY equipamento_id ORDER BY timestamp_dados) as timestamp_anterior
        FROM equipamentos_dados
        WHERE timestamp_dados >= NOW() - INTERVAL '24 hours'
      )
      SELECT
        e.nome,
        e.topico_mqtt,
        dt.timestamp_anterior as inicio_gap,
        dt.timestamp_dados as fim_gap,
        EXTRACT(EPOCH FROM (dt.timestamp_dados - dt.timestamp_anterior))/60 as minutos_sem_dados
      FROM dados_timeline dt
      JOIN equipamentos e ON dt.equipamento_id = e.id
      WHERE dt.timestamp_anterior IS NOT NULL
        AND EXTRACT(EPOCH FROM (dt.timestamp_dados - dt.timestamp_anterior))/60 > 15
      ORDER BY minutos_sem_dados DESC
      LIMIT 20
    `;

    return gaps.map(g => ({
      ...g,
      inicio_gap: g.inicio_gap?.toISOString(),
      fim_gap: g.fim_gap?.toISOString(),
      minutos_sem_dados: Number(g.minutos_sem_dados)
    }));
  }

  /**
   * Últimos registros
   */
  async getUltimosRegistros(limit: number = 10) {
    const ultimos = await this.prisma.$queryRaw<any[]>`
      SELECT
        ed.id,
        e.nome as equipamento,
        e.topico_mqtt,
        ed.timestamp_dados,
        ed.created_at,
        ed.fonte,
        ed.qualidade,
        ed.num_leituras
      FROM equipamentos_dados ed
      JOIN equipamentos e ON ed.equipamento_id = e.id
      ORDER BY ed.created_at DESC
      LIMIT ${limit}
    `;

    return ultimos.map(u => ({
      ...u,
      timestamp_dados: u.timestamp_dados?.toISOString(),
      created_at: u.created_at?.toISOString(),
      num_leituras: u.num_leituras ? Number(u.num_leituras) : null
    }));
  }
}
