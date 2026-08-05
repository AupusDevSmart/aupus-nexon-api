import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService, Prisma, ScopedUser } from '@aupus/api-shared';
import { FusionSolarService } from '../integracoes/fusion-solar/fusion-solar.service';
import { IsolarCloudService } from '../integracoes/isolarcloud/isolarcloud.service';
import { DeyeCloudService } from '../integracoes/deye-cloud/deye-cloud.service';

/**
 * Gestão das configs de sync de nuvem (`unidade_fv_config`): quais usinas puxar, de qual
 * provedor, com que periodicidade e liga/desliga. Impõe o teto de 2000 req/hora POR PROVEDOR
 * (limite da API iSolarCloud etc.) — bloqueia salvar config que estoure. RBAC: super_admin/
 * admin/analista (mesmo gate da curadoria manual).
 */
const PAPEIS_EDITORES = ['super_admin', 'admin', 'analista'];
const PROVEDORES = ['isolarcloud', 'fusion_solar', 'deye'];
const FREQ_MIN_MINUTOS = 5; // não deixa configurar mais rápido que 5 min

/**
 * Teto de requisições/hora POR PROVEDOR (limites das APIs de nuvem):
 * - isolarcloud: 2000/h (plano Free — confirmado).
 * - fusion_solar: Huawei Northbound = 5 chamadas / 10 min = 30/h. ATENÇÃO: há também cap
 *   DIÁRIO = roundup(nº_plantas/100)+24 chamadas/dia (erro 407 se estourar) → pra poucas
 *   plantas ~25/dia; por isso Fusion praticamente só suporta 1×/dia.
 * - deye: limite não publicado na doc — placeholder conservador (A CONFIRMAR em developer.deyecloud.com).
 */
const LIMITES_REQ_HORA: Record<string, number> = {
  isolarcloud: 2000,
  fusion_solar: 30,
  deye: 500,
};
const LIMITE_PADRAO = 500;
const limiteDe = (prov: string): number => LIMITES_REQ_HORA[prov] ?? LIMITE_PADRAO;

export interface ConfigFvInput {
  unidadeId: string;
  provedorMonitoramento: string;
  provedorPlantaId: string;
  predicaoDiariaKwh?: number | null;
  frequenciaMin?: number;
  ativo?: boolean;
}

@Injectable()
export class ConfigFvService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fusion: FusionSolarService,
    private readonly isolar: IsolarCloudService,
    private readonly deye: DeyeCloudService,
  ) {}

  /** Lista as plantas do provedor (via API) pro seletor — usuário escolhe em vez de digitar o ID. */
  async listarPlantasProvedor(provedor: string): Promise<Array<{ id: string; nome: string; capacidade_kwp: number | null }>> {
    if (!PROVEDORES.includes(provedor)) throw new BadRequestException(`provedor inválido (use: ${PROVEDORES.join(', ')})`);
    if (provedor === 'isolarcloud') {
      const st = await this.isolar.listStations();
      return st.map((s) => ({ id: s.psId, nome: s.psName, capacidade_kwp: s.capacityKwp }));
    }
    if (provedor === 'fusion_solar') {
      const st = await this.fusion.listStations();
      return st.map((s) => ({ id: s.plantCode, nome: s.plantName, capacidade_kwp: s.capacity ?? null }));
    }
    const st = await this.deye.listStations();
    return st.map((s) => ({ id: String(s.stationId), nome: s.name, capacidade_kwp: s.capacityKwp }));
  }

  assertEditor(user?: ScopedUser): void {
    if (!user?.role || !PAPEIS_EDITORES.includes(user.role)) {
      throw new ForbiddenException('Apenas analistas e administradores podem gerenciar o sync FV.');
    }
  }

  /** req/hora de uma config ativa = 60 / frequencia_min (1 chamada por sync). */
  private reqHora(frequenciaMin: number): number {
    return 60 / Math.max(frequenciaMin, 1);
  }

  /** Lista as configs + resumo de budget por provedor (req/h usadas × limite). */
  async listar(): Promise<{
    configs: Array<{ unidade_id: string; nome: string; provedor: string; provedor_planta_id: string; predicao: number | null; frequencia_min: number; ativo: boolean; ultima_sync: string | null; req_hora: number }>;
    budget: Array<{ provedor: string; req_hora: number; limite: number; folga: number; usinas_ativas: number }>;
  }> {
    const configs = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(c.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             c.provedor_monitoramento AS provedor, c.provedor_planta_id AS provedor_planta_id,
             COALESCE(u.predicao_diaria_kwh, c.predicao_diaria_kwh)::float8 AS predicao, c.frequencia_min AS frequencia_min,
             c.ativo AS ativo, to_char(c.ultima_sync_em, 'YYYY-MM-DD HH24:MI') AS ultima_sync
      FROM unidade_fv_config c
      JOIN unidades u ON TRIM(u.id) = TRIM(c.unidade_id) AND u.deleted_at IS NULL
      ORDER BY c.provedor_monitoramento, nome
    `;
    for (const c of configs) c.req_hora = c.ativo ? Number(this.reqHora(c.frequencia_min).toFixed(3)) : 0;

    const budgetMap = new Map<string, { req_hora: number; usinas_ativas: number }>();
    for (const c of configs) {
      const b = budgetMap.get(c.provedor) ?? { req_hora: 0, usinas_ativas: 0 };
      if (c.ativo) { b.req_hora += this.reqHora(c.frequencia_min); b.usinas_ativas += 1; }
      budgetMap.set(c.provedor, b);
    }
    const budget = [...budgetMap.entries()].map(([provedor, b]) => ({
      provedor,
      req_hora: Number(b.req_hora.toFixed(2)),
      limite: limiteDe(provedor),
      folga: Number((limiteDe(provedor) - b.req_hora).toFixed(2)),
      usinas_ativas: b.usinas_ativas,
    }));
    return { configs, budget };
  }

  /** Unidades FV que ainda NÃO têm config (p/ o dropdown de adicionar). */
  async unidadesDisponiveis(): Promise<Array<{ unidade_id: string; nome: string }>> {
    return this.prisma.$queryRaw`
      SELECT TRIM(u.id) AS unidade_id, TRIM(u.nome) AS nome
      FROM unidades u
      WHERE u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM unidade_fv_config c WHERE TRIM(c.unidade_id) = TRIM(u.id))
        AND lower(COALESCE(u.tipo,'')) <> 'carga'
      ORDER BY nome
    `;
  }

  /** req/h total do provedor SE aplicarmos a mudança proposta (exclui a config atual da unidade). */
  private async reqHoraProvedorSimulado(provedor: string, unidadeId: string, novaFreq: number, novoAtivo: boolean): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ frequencia_min: number }>>(Prisma.sql`
      SELECT c.frequencia_min FROM unidade_fv_config c
      WHERE c.provedor_monitoramento = ${provedor} AND c.ativo = true
        AND TRIM(c.unidade_id) <> ${unidadeId.trim()}
    `);
    let total = rows.reduce((s, r) => s + this.reqHora(r.frequencia_min), 0);
    if (novoAtivo) total += this.reqHora(novaFreq);
    return total;
  }

  async upsert(input: ConfigFvInput): Promise<void> {
    const unidadeId = input.unidadeId?.trim();
    const provedor = input.provedorMonitoramento?.trim();
    const plantaId = input.provedorPlantaId?.trim();
    const freq = Math.round(Number(input.frequenciaMin ?? 1440));
    const ativo = input.ativo !== false;
    const predicao = input.predicaoDiariaKwh != null ? Number(input.predicaoDiariaKwh) : null;

    if (!unidadeId) throw new BadRequestException('unidadeId obrigatório');
    if (!PROVEDORES.includes(provedor)) throw new BadRequestException(`provedor inválido (use: ${PROVEDORES.join(', ')})`);
    if (!plantaId) throw new BadRequestException('provedor_planta_id obrigatório');
    if (!Number.isFinite(freq) || freq < FREQ_MIN_MINUTOS) throw new BadRequestException(`frequência mínima é ${FREQ_MIN_MINUTOS} min`);
    if (predicao != null && (!Number.isFinite(predicao) || predicao < 0)) throw new BadRequestException('predição inválida');

    const uOk = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT TRIM(id) AS id FROM unidades WHERE TRIM(id) = ${unidadeId} AND deleted_at IS NULL LIMIT 1`,
    );
    if (uOk.length === 0) throw new BadRequestException('unidade não encontrada');

    // TETO 2000/h por provedor — bloqueia se estourar
    if (ativo) {
      const total = await this.reqHoraProvedorSimulado(provedor, unidadeId, freq, true);
      const limite = limiteDe(provedor);
      if (total > limite) {
        throw new BadRequestException(
          `Estouraria o limite do provedor ${provedor}: ${total.toFixed(1)} req/h > ${limite}. Reduza a frequência ou desative usinas.`,
        );
      }
    }

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO unidade_fv_config
        (unidade_id, provedor_monitoramento, provedor_planta_id, predicao_diaria_kwh, frequencia_min, ativo, updated_at)
      VALUES (${unidadeId}, ${provedor}, ${plantaId}, ${predicao}, ${freq}, ${ativo}, now())
      ON CONFLICT (unidade_id) DO UPDATE SET
        provedor_monitoramento = ${provedor},
        provedor_planta_id     = ${plantaId},
        predicao_diaria_kwh    = ${predicao},
        frequencia_min         = ${freq},
        ativo                  = ${ativo},
        updated_at             = now()
    `);

    // Meta = propriedade da INSTALACAO. Editar a predicao aqui (ou no cadastro da
    // unidade) grava no MESMO lugar: unidades.predicao_diaria_kwh (fonte unica).
    if (predicao != null) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE unidades SET predicao_diaria_kwh = ${predicao}, updated_at = now()
        WHERE TRIM(id) = ${unidadeId}
      `);
    }
  }

  async remover(unidadeId: string): Promise<{ removidas: number }> {
    const n = await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM unidade_fv_config WHERE TRIM(unidade_id) = ${unidadeId.trim()}`,
    );
    return { removidas: Number(n) || 0 };
  }
}
