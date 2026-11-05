import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { capacidades, MSG_SOMENTE_LEITURA, papelCanonico } from '@/core/modules/auth/papeis';
import { MqttService } from '@/shared/mqtt/mqtt.service';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import {
  CONTROLES, ComandoInv, Controle, decidirDemanda, decidirFp, despachar, EstadoAnterior, grandezas, InvAoVivo,
  janelaReativa, lerMinuto, MinutoSsu, Modo, Modos, MODOS_PADRAO, Params, PARAMS_PADRAO, PedidoDemanda, PedidoFp,
  portaoMedidor, qDisponivel, SetpointInv, Ufv, validarCadastro, fmt,
} from './controle-med.calc';

/** Estado de cada MED entre um minuto e outro (memória do processo; refeito no restart). */
interface EstadoMed {
  ant: EstadoAnterior | null;
  projG: number | null; projC: number | null;
  aguardG: boolean; aguardC: boolean;
  setpoints: Record<string, SetpointInv>;     // aplicados (ativo) ou simulados (sombra)
  enviadoEm: Record<string, number>;          // último p_lim enviado (confirmação, item 10)
  falhas: Record<string, number>;
  ultimoAjusteFp: number;
  validos: number;                            // ciclos válidos seguidos (retomada, 11.2)
  houveFalha: boolean;
}

const ROTULO: Record<Controle, string> = { fp: 'FP', demanda_g: 'Demanda de geração', demanda_c: 'Demanda de carga' };
const MODOS_VALIDOS: readonly Modo[] = ['desligado', 'sombra', 'ativo'];
const RETENCAO_DIAS = 30;

/**
 * Controle automático pelo MED Concessionária (docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md).
 * Ciclo disparado por EVENTO: cada minuto do medidor (SSU da TON-V2) que chega no MQTT. Cada controle
 * tem modo próprio: desligado · sombra (calcula e registra o que mandaria) · ativo (manda o setpoint).
 */
@Injectable()
export class ControleMedService implements OnModuleInit {
  private readonly logger = new Logger(ControleMedService.name);
  private mapaSsu = new Map<string, string[]>();   // equipamento da SSU → MEDs com controle ligado
  private mapaEm = 0;
  private espera = new Map<string, { dados: any; ts: Date; t: NodeJS.Timeout }>();
  private estados = new Map<string, EstadoMed>();
  private rodando = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly scope: PermissionScopeService,
    private readonly cmd: EquipamentosCmdService,
  ) {}

  onModuleInit() {
    this.mqtt.on('ssu_minuto', (e: { equipamentoId: string; dados: any; ts: Date }) => this.aoMinuto(e));
  }

  // ------------------------------------------------------------------ evento

  /**
   * Um POLL do LoRa pode trazer vários minutos de uma vez (fila do satélite): espera 3 s sem
   * minuto novo e roda o ciclo só com o último — os anteriores só completam o acumulado (R7).
   */
  private aoMinuto(e: { equipamentoId: string; dados: any; ts: Date }) {
    const id = String(e?.equipamentoId ?? '').trim();
    if (!id) return;
    const ant = this.espera.get(id);
    if (ant) clearTimeout(ant.t);
    const t = setTimeout(() => {
      const ult = this.espera.get(id);
      this.espera.delete(id);
      if (ult) void this.processarSsu(id, ult.dados, ult.ts).catch((x) => this.logger.warn(`[ciclo] ${id}: ${x?.message ?? x}`));
    }, 3000);
    this.espera.set(id, { dados: e.dados, ts: e.ts, t });
  }

  private async medsDaSsu(ssuId: string): Promise<string[]> {
    if (Date.now() - this.mapaEm > 5 * 60_000) await this.recarregarMapa();
    return this.mapaSsu.get(ssuId) ?? [];
  }

  /** MED com algum controle fora de "desligado" → device IoT que lê o medidor (mesmo lookup da ficha). */
  private async recarregarMapa() {
    const rows = await this.prisma.$queryRaw<Array<{ med_id: string; ssu_id: string | null }>>`
      SELECT TRIM(c.med_id) AS med_id,
             (SELECT TRIM(ic.props->>'equipamento_id') FROM iot_componentes ic
               WHERE ic.props->>'disjuntor_equipamento_id' = TRIM(c.med_id)
                 AND COALESCE(ic.props->>'equipamento_id', '') <> '' LIMIT 1) AS ssu_id
      FROM controle_med_config c
      WHERE EXISTS (SELECT 1 FROM jsonb_each_text(c.modos) m WHERE m.value <> 'desligado')`.catch(() => []);
    const mapa = new Map<string, string[]>();
    for (const r of rows) {
      const ssu = r.ssu_id || r.med_id;   // sem vínculo: o próprio MED recebe a SSU
      mapa.set(ssu, [...(mapa.get(ssu) ?? []), r.med_id]);
    }
    this.mapaSsu = mapa;
    this.mapaEm = Date.now();
  }

  private async processarSsu(ssuId: string, dados: any, ts: Date) {
    const m = lerMinuto(dados, ts.getTime());
    if (!m) return;
    for (const medId of await this.medsDaSsu(ssuId)) {
      if (this.rodando.has(medId)) continue;
      this.rodando.add(medId);
      try {
        await this.ciclo(medId, ssuId, m);
      } catch (x: any) {
        this.logger.warn(`[ciclo] MED ${medId}: ${x?.message ?? x}`);
      } finally {
        this.rodando.delete(medId);
      }
    }
  }

  // ------------------------------------------------------------------ ciclo

  private estadoDe(medId: string): EstadoMed {
    let e = this.estados.get(medId);
    if (!e) {
      e = { ant: null, projG: null, projC: null, aguardG: false, aguardC: false, setpoints: {}, enviadoEm: {}, falhas: {}, ultimoAjusteFp: 0, validos: 0, houveFalha: false };
      this.estados.set(medId, e);
    }
    return e;
  }

  /** Inversores das UFVs: P atual e se estão disponíveis (leitura nova, sem falha de confirmação). */
  private async aoVivo(ufvs: Ufv[], p: Params, est: EstadoMed): Promise<Record<string, InvAoVivo>> {
    const ids = ufvs.flatMap((u) => u.inversores.map((i) => i.id));
    if (!ids.length) return {};
    type Linha = { id: string; ts: Date; p_w: number | null; kw: number | null };
    const rows: Linha[] = await this.prisma.$queryRaw<Linha[]>`
      SELECT DISTINCT ON (d.equipamento_id) TRIM(d.equipamento_id) AS id, d.timestamp_dados AS ts,
             (d.dados->'power'->>'active_total')::float AS p_w, d.potencia_ativa_kw::float AS kw
      FROM equipamentos_dados d
      WHERE d.equipamento_id = ANY(${ids}::bpchar[]) AND d.timestamp_dados > now() - interval '30 minutes'
      ORDER BY d.equipamento_id, d.timestamp_dados DESC`.catch(() => []);
    const porId = new Map<string, Linha>(rows.map((r) => [r.id, r]));
    const out: Record<string, InvAoVivo> = {};
    for (const u of ufvs) for (const i of u.inversores) {
      const r = porId.get(i.id);
      const idade = r ? (Date.now() - new Date(r.ts).getTime()) / 1000 : Infinity;
      const max = u.rota === 'lora' ? p.idade_max_inv_lora_s : p.idade_max_inv_internet_s;
      const P = r ? (r.p_w != null ? r.p_w / 1000 : r.kw) : null;
      if (!r || P == null) out[i.id] = { id: i.id, P_kw: null, disponivel: false, motivo: 'sem leitura do inversor' };
      else if (idade > max) out[i.id] = { id: i.id, P_kw: P, disponivel: false, motivo: `leitura com ${Math.round(idade)} s (máx. ${max} s)` };
      else if ((est.falhas[i.id] ?? 0) >= 3) out[i.id] = { id: i.id, P_kw: P, disponivel: false, motivo: 'não obedeceu ao limite 3 vezes' };
      else out[i.id] = { id: i.id, P_kw: P, disponivel: true };
    }
    return out;
  }

  /** Acumulado da hora (minutos da SSU) para o FP horário + P̂ dos últimos 5 min. */
  private async horaSsu(ssuId: string, m: MinutoSsu) {
    const ini = new Date(Math.floor(m.ts / 3_600_000) * 3_600_000);
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; ke: number; phf: number; phr: number; qhfi: number; qhfc: number; qhri: number; qhrc: number }>>`
      SELECT ts, ke::float AS ke, phf, phr, qhfi, qhfc, qhri, qhrc FROM ssu_minutos
      WHERE equipamento_id = ${ssuId}::bpchar AND ts >= ${new Date(Math.min(ini.getTime(), m.ts - 5 * 60_000))}
      ORDER BY ts`.catch(() => []);
    let E_P = 0, E_ind = 0, E_cap = 0;
    const ult5: number[] = [];
    for (const r of rows) {
      const k = Number(r.ke) || m.ke;
      const t = new Date(r.ts).getTime();
      if (t >= ini.getTime()) {
        E_P += Number(r.phf) * k;
        E_ind += (Number(r.qhfi) + Number(r.qhri)) * k;
        E_cap += (Number(r.qhfc) + Number(r.qhrc)) * k;
      }
      if (t >= m.ts - 5 * 60_000) ult5.push(Number(r.phf) * k * 60);
    }
    return {
      E_P, E_ind, E_cap,
      P_hat: ult5.length ? ult5.reduce((a, b) => a + b, 0) / ult5.length : grandezas(m).P_imp,
      t_rest: Math.max(0, ini.getTime() + 3_600_000 - m.ts) / 1000,
    };
  }

  private async ciclo(medId: string, ssuId: string, m: MinutoSsu) {
    const cfg = await this.lerConfig(medId);
    if (!cfg) return;
    const { params: p, ufvs, modos } = cfg;
    const est = this.estadoDe(medId);
    const eventos: string[] = [];
    const g = grandezas(m);
    const portao = portaoMedidor(m, est.ant, p, Date.now());
    est.ant = { nsu: m.nsu, seg: m.seg, ssu_err: m.ssu_err, ts: m.ts };

    // Fechamento do intervalo: confere a demanda final contra o contrato (registro de ultrapassagem).
    if (m.fim === 1) {
      const Dg = (g.E_exp * 3600) / g.T, Dc = (g.E_imp * 3600) / g.T;
      const contrC = m.posto === 1 ? (p.d_contr_c_ponta_kw ?? p.d_contr_c_kw) : p.d_contr_c_kw;
      if (p.d_contr_g_kw && Dg > p.d_contr_g_kw) eventos.push(`Ultrapassagem de geração: intervalo fechou em ${fmt(Dg)} kW / ${fmt(p.d_contr_g_kw)} kW`);
      if (contrC && Dc > contrC) eventos.push(`Ultrapassagem de carga: intervalo fechou em ${fmt(Dc)} kW / ${fmt(contrC)} kW`);
      est.projG = null; est.projC = null; est.aguardG = false; est.aguardC = false;
    }
    // fim=1: o acumulado é do intervalo que FECHOU; o novo começa do zero.
    const E_exp = m.fim === 1 ? 0 : g.E_exp, E_imp = m.fim === 1 ? 0 : g.E_imp;

    const vivo = await this.aoVivo(ufvs, p, est);
    const entradas: Record<string, unknown> = {
      E_imp, E_exp, P_imp: g.P_imp, P_exp: g.P_exp, Q_ind: g.Q_ind, Q_cap: g.Q_cap, T: g.T, posto: m.posto, q: m.q,
      ssu_err: m.ssu_err, inversores: vivo,
    };
    const pedidos: Record<string, unknown> = {};

    if (!portao.ok) {
      est.validos = 0; est.houveFalha = true;
      eventos.push(`Portão de qualidade: ${portao.motivos.join('; ')} — mantém o último setpoint`);
      await this.registrar(medId, m, entradas, portao, pedidos, [], modos, eventos);
      return;
    }
    est.validos++;
    if (est.houveFalha && est.validos < p.n_retomada) {
      eventos.push(`Retomada após falha: ${est.validos}/${p.n_retomada} ciclos válidos — mantém o último setpoint`);
      await this.registrar(medId, m, entradas, portao, pedidos, [], modos, eventos);
      return;
    }
    est.houveFalha = false;

    // Confirmação (10): P medido acima do limite enviado depois do tempo de resposta.
    for (const u of ufvs) for (const i of u.inversores) {
      const em = est.enviadoEm[i.id];
      const sp = est.setpoints[i.id];
      const v = vivo[i.id];
      if (!em || !sp || v?.P_kw == null || Date.now() - em < p.t_resposta_s * 1000) continue;
      if (v.P_kw > sp.p_lim_kw * 1.05 + 1) {
        est.falhas[i.id] = (est.falhas[i.id] ?? 0) + 1;
        if (est.falhas[i.id] === 3) eventos.push(`${i.nome ?? i.id}: P ${fmt(v.P_kw)} kW acima do limite ${fmt(sp.p_lim_kw)} kW — inversor fora da distribuição`);
      } else est.falhas[i.id] = 0;
    }

    const disponiveis = ufvs.flatMap((u) => u.inversores).filter((i) => vivo[i.id]?.disponivel);
    const P_ufvs = disponiveis.reduce((a, i) => a + Math.max(0, vivo[i.id]?.P_kw ?? 0), 0);
    const folgaLimitada = disponiveis.reduce((a, i) => a + Math.max(0, i.pn_kw - (est.setpoints[i.id]?.p_lim_kw ?? i.pn_kw)), 0);

    // Demanda de carga (prioridade 2) e de geração (3)
    let pedC: PedidoDemanda | null = null, pedG: PedidoDemanda | null = null;
    if (modos.demanda_c !== 'desligado') {
      const contr = m.posto === 1 ? (p.d_contr_c_ponta_kw ?? p.d_contr_c_kw) : p.d_contr_c_kw;
      pedC = decidirDemanda({
        E_kwh: E_imp, P_kw: g.P_imp, seg: m.seg, T: g.T, contrato: contr, alvo_pct: p.alvo_c_pct, corteMax: folgaLimitada,
        t_resposta_s: p.t_resposta_s, projAnt: est.projC, aguardando: est.aguardC, banda_pct: p.banda_pct, folgaLimitada: 0,
      });
      est.projC = pedC.D_proj; est.aguardC = pedC.acao === 'aguardar';
      if (pedC.acao === 'reduzir' && pedC.dP > folgaLimitada + 0.5) {
        eventos.push(`Demanda de carga: faltam ${fmt(pedC.dP - folgaLimitada)} kW além da geração liberável — SEP indisponível (nenhuma carga habilitada)`);
      }
      pedidos.demanda_c = pedC;
    }
    if (modos.demanda_g !== 'desligado') {
      pedG = decidirDemanda({
        E_kwh: E_exp, P_kw: g.P_exp, seg: m.seg, T: g.T, contrato: p.d_contr_g_kw, alvo_pct: p.alvo_g_pct, corteMax: P_ufvs,
        t_resposta_s: p.t_resposta_s, projAnt: est.projG, aguardando: est.aguardG, banda_pct: p.banda_pct, folgaLimitada,
      });
      est.projG = pedG.D_proj; est.aguardG = pedG.acao === 'aguardar';
      if (pedG.acao === 'reduzir' && pedG.dP > P_ufvs + 0.5) eventos.push(`Demanda de geração: cortar ${fmt(pedG.dP)} kW mas só há ${fmt(P_ufvs)} kW nas UFVs controladas`);
      pedidos.demanda_g = pedG;
    }

    // FP (prioridade 5)
    let pedFp: PedidoFp | null = null;
    let Q_alvo_total: number | null = null;
    const noite = P_ufvs < 1;
    const Q_ufv_atual = disponiveis.reduce((a, i) => a + (est.setpoints[i.id]?.q_kvar ?? 0), 0);
    if (modos.fp !== 'desligado') {
      const h = await this.horaSsu(ssuId, m);
      const janela = janelaReativa(m, p);
      const Q_disp_total = disponiveis.reduce((a, i) => a + qDisponivel(i, Math.max(0, vivo[i.id]?.P_kw ?? 0), noite), 0);
      pedFp = decidirFp({
        janela, E_P_h: h.E_P, E_Q_h: janela === 'ind' ? h.E_ind : h.E_cap, P_hat: h.P_hat,
        Q_med: janela === 'ind' ? g.Q_ind : g.Q_cap, t_rest_hora: h.t_rest,
        fp_lim: janela === 'ind' ? p.fp_lim_ind : p.fp_lim_cap, fp_alvo: janela === 'ind' ? p.fp_alvo_ind : p.fp_alvo_cap,
        banda_kvar: Math.max(1, Q_disp_total * p.banda_pct / 100), margem_q3: p.margem_q3_kvar,
        Q_ufv_atual, Q_disp_total, desdeUltimoAjuste: (Date.now() - est.ultimoAjusteFp) / 1000, t_min_ajuste: p.t_min_ajuste_fp_s,
      });
      if (pedFp.acao === 'compensar' || pedFp.acao === 'devolver') {
        // janela indutiva: compensar = fornecer Q (≥ 0); capacitiva: absorver (≤ 0)
        Q_alvo_total = janela === 'ind' ? Math.max(0, Q_ufv_atual + pedFp.dQ) : Math.min(0, Q_ufv_atual - pedFp.dQ);
      }
      if (pedFp.acao === 'hora_perdida' || pedFp.acao === 'sem_atuador') eventos.push(pedFp.motivo);
      pedidos.fp = pedFp;
      Object.assign(entradas, { hora: h, janela });
    }

    const val = validarCadastro(p, ufvs);
    const { comandos } = despachar({
      ufvs, vivo, atuais: est.setpoints,
      dP_g: pedG?.acao === 'reduzir' ? pedG.dP : pedG?.acao === 'liberar' ? -pedG.dP : 0,
      dP_c: pedC?.acao === 'reduzir' ? Math.min(pedC.dP, folgaLimitada) : 0,
      Q_alvo_total, noite, tetoPlim: val.tetoPlim, degrau_min_pct: p.degrau_min_pct,
      controlaP: modos.demanda_g !== 'desligado' || modos.demanda_c !== 'desligado',
    });

    const ativoP = modos.demanda_g === 'ativo' || modos.demanda_c === 'ativo';
    const sombraP = modos.demanda_g === 'sombra' || modos.demanda_c === 'sombra';
    const resultado: Array<ComandoInv & { enviado_p?: string; enviado_q?: string }> = [];
    let mudouQ = false;
    for (const c of comandos) {
      const r: ComandoInv & { enviado_p?: string; enviado_q?: string } = { ...c };
      const sp = { ...(est.setpoints[c.inversor_id] ?? { p_lim_kw: c.p_lim_kw, q_kvar: 0 }) };
      if (c.muda_p && (ativoP || sombraP)) {
        if (ativoP) {
          r.enviado_p = await this.enviar(c.inversor_id, 'sp_limite_pct', c.p_pct);
          if (r.enviado_p === 'ok') { sp.p_lim_kw = c.p_lim_kw; est.enviadoEm[c.inversor_id] = Date.now(); }
        } else { r.enviado_p = 'sombra'; sp.p_lim_kw = c.p_lim_kw; }
      }
      if (c.muda_q && modos.fp !== 'desligado') {
        if (modos.fp === 'ativo') {
          r.enviado_q = await this.enviar(c.inversor_id, 'sp_q_pct', c.q_pct);
          if (r.enviado_q === 'ok') { sp.q_kvar = c.q_kvar; mudouQ = true; }
        } else { r.enviado_q = 'sombra'; sp.q_kvar = c.q_kvar; mudouQ = true; }
      }
      est.setpoints[c.inversor_id] = sp;
      resultado.push(r);
    }
    if (mudouQ) est.ultimoAjusteFp = Date.now();
    await this.registrar(medId, m, entradas, portao, pedidos, resultado, modos, eventos);
  }

  /** Setpoint pelo caminho já existente (TON → Modbus). Devolve 'ok' ou o motivo da falha. */
  private async enviar(invId: string, sp: 'sp_limite_pct' | 'sp_q_pct', valor: number): Promise<string> {
    try {
      const r = await this.cmd.enviarSetpoint(invId, sp, valor);
      return r.status === 'ok' || r.status === 'duplicate' ? 'ok' : String(r.status);
    } catch (x: any) {
      return x?.response?.message || x?.message || 'falha';
    }
  }

  private async registrar(medId: string, m: MinutoSsu, entradas: unknown, portao: unknown, pedidos: unknown, comandos: unknown, modos: Modos, eventos: string[]) {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO controle_med_ciclos (med_id, ts, nsu, seg, entradas, portao, pedidos, comandos, modos)
        VALUES (${medId}, ${new Date(m.ts)}, ${m.nsu}, ${m.seg}, ${JSON.stringify({ ...(entradas as object), eventos })}::jsonb,
                ${JSON.stringify(portao)}::jsonb, ${JSON.stringify(pedidos)}::jsonb, ${JSON.stringify(comandos)}::jsonb, ${JSON.stringify(modos)}::jsonb)`;
      if (Math.random() < 0.01) {
        await this.prisma.$executeRaw`DELETE FROM controle_med_ciclos WHERE ts < ${new Date(Date.now() - RETENCAO_DIAS * 86_400_000)}`;
      }
    } catch (x: any) {
      this.logger.warn(`[registro] ${medId}: ${x?.message ?? x}`);
    }
  }

  // ------------------------------------------------------------------ cadastro

  private async lerConfig(medId: string): Promise<{ params: Params; ufvs: Ufv[]; modos: Modos; versao: number; existe: boolean } | null> {
    const eq = await this.prisma.$queryRaw<Array<{ dc: number | null; dg: number | null }>>`
      SELECT u.demanda_carga::float AS dc, u.demanda_geracao::float AS dg
      FROM equipamentos e LEFT JOIN unidades u ON u.id = e.unidade_id
      WHERE e.id = ${medId}::bpchar AND e.deleted_at IS NULL`;
    if (!eq[0]) return null;
    const rows = await this.prisma.$queryRaw<Array<{ params: any; ufvs: any; modos: any; versao: number }>>`
      SELECT params, ufvs, modos, versao FROM controle_med_config WHERE med_id = ${medId}::bpchar`.catch(() => []);
    const r = rows[0];
    // contrato vazio no cadastro do controle = o da unidade consumidora
    const params: Params = { ...PARAMS_PADRAO, ...(r?.params ?? {}) };
    if (params.d_contr_g_kw == null) params.d_contr_g_kw = eq[0].dg ?? null;
    if (params.d_contr_c_kw == null) params.d_contr_c_kw = eq[0].dc ?? null;
    return {
      params,
      ufvs: Array.isArray(r?.ufvs) ? r.ufvs : [],
      modos: { ...MODOS_PADRAO, ...(r?.modos ?? {}) },
      versao: r?.versao ?? 0,
      existe: !!r,
    };
  }

  private exigir(user: ScopedUser | undefined, o_que: 'configurar' | 'operar') {
    // controle.configurar / controle.operar (R10): papéis de configuração técnica (admin e analistas)
    if (!user || !capacidades(papelCanonico(user.role)).configTecnica) {
      throw new ForbiddenException(o_que === 'configurar' ? MSG_SOMENTE_LEITURA : 'Ligar ou desligar o controle é só para a equipe técnica.');
    }
  }

  private async assertMed(medId: string, user?: ScopedUser) {
    const id = (medId ?? '').trim();
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    const eq = await this.prisma.$queryRaw<Array<{ codigo: string | null; unidade_id: string | null; planta_id: string | null }>>`
      SELECT t.codigo, TRIM(e.unidade_id) AS unidade_id, TRIM(COALESCE(e.planta_id, u.planta_id)) AS planta_id
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN unidades u ON u.id = e.unidade_id
      WHERE e.id = ${id}::bpchar AND e.deleted_at IS NULL`;
    if (!eq[0]) throw new NotFoundException('Equipamento não encontrado.');
    if (eq[0].codigo !== 'EQTL001') throw new BadRequestException('O controle automático é do medidor da concessionária (MED).');
    return { id, unidadeId: eq[0].unidade_id, plantaId: eq[0].planta_id };
  }

  /** Inversores da mesma unidade (ou planta) que o firmware sabe comandar (limite de P e Q). */
  private async candidatos(unidadeId: string | null, plantaId: string | null) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; nome: string; pn: string | null }>>`
      SELECT TRIM(e.id) AS id, e.nome,
             (SELECT d.valor FROM equipamentos_dados_tecnicos d
               WHERE d.equipamento_id = e.id AND d.campo IN ('potencia_nominal', 'Potência Nominal CA') LIMIT 1) AS pn
      FROM equipamentos e JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN unidades u ON u.id = e.unidade_id
      WHERE e.deleted_at IS NULL AND t.codigo = 'INVERSOR'
        AND (e.unidade_id = ${unidadeId}::bpchar OR COALESCE(e.planta_id, u.planta_id) = ${plantaId}::bpchar)
      ORDER BY e.nome`;
    const out = [];
    for (const r of rows) {
      const sp = await this.cmd.listarSetpoints(r.id).catch(() => null);
      const ids = new Set((sp?.setpoints ?? []).map((s: any) => s.id));
      const pn = Number(String(r.pn ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
      out.push({
        id: r.id, nome: r.nome.trim(), modelo: sp?.modelo ?? null,
        pn_kw: Number.isFinite(pn) && pn > 0 ? (pn > 5000 ? pn / 1000 : pn) : null,
        limite_p: ids.has('sp_limite_pct'), reativo_q: ids.has('sp_q_pct'),
      });
    }
    return out;
  }

  async obter(medId: string, user?: ScopedUser) {
    const { id, unidadeId, plantaId } = await this.assertMed(medId, user);
    const cfg = await this.lerConfig(id);
    if (!cfg) throw new NotFoundException('Equipamento não encontrado.');
    const ult = await this.prisma.$queryRaw<any[]>`
      SELECT ts, nsu, seg, entradas, portao, pedidos, comandos, modos, created_at
      FROM controle_med_ciclos WHERE med_id = ${id}::bpchar ORDER BY ts DESC LIMIT 1`.catch(() => []);
    const pode = !!user && capacidades(papelCanonico(user.role)).configTecnica;
    return {
      params: cfg.params, ufvs: cfg.ufvs, modos: cfg.modos, versao: cfg.versao, existe: cfg.existe,
      padrao: PARAMS_PADRAO,
      validacao: validarCadastro(cfg.params, cfg.ufvs),
      candidatos: pode ? await this.candidatos(unidadeId, plantaId) : [],
      ultimo_ciclo: ult[0] ?? null,
      pode_configurar: pode, pode_operar: pode,
    };
  }

  async ciclos(medId: string, limite: number, user?: ScopedUser) {
    const { id } = await this.assertMed(medId, user);
    const n = Math.max(1, Math.min(240, Math.round(Number(limite) || 60)));
    return this.prisma.$queryRaw<any[]>`
      SELECT ts, nsu, seg, entradas, portao, pedidos, comandos, modos
      FROM controle_med_ciclos WHERE med_id = ${id}::bpchar ORDER BY ts DESC LIMIT ${n}`;
  }

  /** Grava parâmetros e UFVs (controle.configurar) com histórico; zera o estado do ciclo. */
  async salvarConfig(medId: string, body: any, user?: ScopedUser) {
    const { id } = await this.assertMed(medId, user);
    this.exigir(user, 'configurar');
    const atual = await this.lerConfig(id);
    const params = sanitizarParams({ ...(atual?.params ?? PARAMS_PADRAO), ...(body?.params ?? {}) });
    const ufvs = sanitizarUfvs(body?.ufvs ?? atual?.ufvs ?? []);
    const versao = (atual?.versao ?? 0) + 1;
    const autor = user?.id?.trim() ?? null;
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO controle_med_config (med_id, params, ufvs, versao, updated_by, updated_at)
        VALUES (${id}, ${JSON.stringify(params)}::jsonb, ${JSON.stringify(ufvs)}::jsonb, ${versao}, ${autor}, now())
        ON CONFLICT (med_id) DO UPDATE SET params = EXCLUDED.params, ufvs = EXCLUDED.ufvs, versao = EXCLUDED.versao,
          updated_by = EXCLUDED.updated_by, updated_at = now()`,
      this.prisma.$executeRaw`
        INSERT INTO controle_med_config_hist (med_id, versao, o_que, params, ufvs, resumo, alterado_por)
        VALUES (${id}, ${versao}, 'config', ${JSON.stringify(atual?.params ?? null)}::jsonb, ${JSON.stringify(atual?.ufvs ?? null)}::jsonb,
                ${resumoConfig(atual?.params, params, atual?.ufvs ?? [], ufvs)}, ${autor})`,
    ]);
    this.estados.delete(id);
    this.mapaEm = 0;
    return this.obter(id, user);
  }

  /** Liga/desliga cada controle (controle.operar). "ativo" só com o cadastro mínimo. */
  async salvarModos(medId: string, body: any, user?: ScopedUser) {
    const { id } = await this.assertMed(medId, user);
    this.exigir(user, 'operar');
    const atual = await this.lerConfig(id);
    if (!atual) throw new NotFoundException('Equipamento não encontrado.');
    const modos: Modos = { ...atual.modos };
    for (const c of CONTROLES) {
      const v = body?.modos?.[c] ?? body?.[c];
      if (v === undefined) continue;
      if (!MODOS_VALIDOS.includes(v)) throw new BadRequestException(`Modo inválido para ${ROTULO[c]}: ${v}`);
      modos[c] = v;
    }
    const p = atual.params;
    const algumInv = atual.ufvs.some((u) => u.inversores.length > 0);
    for (const c of CONTROLES) {
      if (modos[c] === 'desligado') continue;
      if (!algumInv) throw new BadRequestException(`${ROTULO[c]}: cadastre pelo menos uma UFV com inversor antes de ligar.`);
      if (c === 'demanda_g' && !p.d_contr_g_kw) throw new BadRequestException('Demanda de geração: informe o contrato de geração.');
      if (c === 'demanda_c' && !p.d_contr_c_kw) throw new BadRequestException('Demanda de carga: informe o contrato de carga.');
      if (modos[c] === 'ativo') {
        const { bloqueios } = validarCadastro(p, atual.ufvs);
        if (bloqueios.length) throw new BadRequestException(`${ROTULO[c]} não pode ficar ativo: ${bloqueios.join(' ')}`);
      }
    }
    const autor = user?.id?.trim() ?? null;
    const versao = atual.versao + 1;
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO controle_med_config (med_id, params, ufvs, modos, versao, updated_by, updated_at)
        VALUES (${id}, ${JSON.stringify(atual.params)}::jsonb, ${JSON.stringify(atual.ufvs)}::jsonb, ${JSON.stringify(modos)}::jsonb, ${versao}, ${autor}, now())
        ON CONFLICT (med_id) DO UPDATE SET modos = EXCLUDED.modos, versao = EXCLUDED.versao, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      this.prisma.$executeRaw`
        INSERT INTO controle_med_config_hist (med_id, versao, o_que, modos, resumo, alterado_por)
        VALUES (${id}, ${versao}, 'modos', ${JSON.stringify(atual.modos)}::jsonb,
                ${CONTROLES.filter((c) => atual.modos[c] !== modos[c]).map((c) => `${ROTULO[c]}: ${atual.modos[c]} → ${modos[c]}`).join('; ') || 'sem mudança'}, ${autor})`,
    ]);
    // troca de modo: recomeça do zero (o que era simulado na sombra não está aplicado)
    this.estados.delete(id);
    this.mapaEm = 0;
    this.logger.log(`[modos] MED ${id}: ${JSON.stringify(modos)} por ${autor}`);
    return this.obter(id, user);
  }

  async historico(medId: string, user?: ScopedUser) {
    const { id } = await this.assertMed(medId, user);
    return this.prisma.$queryRaw<any[]>`
      SELECT h.versao, h.o_que, h.resumo, h.alterado_em, u.nome AS por
      FROM controle_med_config_hist h LEFT JOIN usuarios u ON u.id = h.alterado_por
      WHERE h.med_id = ${id}::bpchar ORDER BY h.alterado_em DESC LIMIT 50`;
  }
}

// ------------------------------------------------------------------ sanitização

const n = (v: unknown, d: number | null, min = -Infinity, max = Infinity): number | null => {
  if (v === null || v === '' || v === undefined) return d;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
};
const hhmm = (v: unknown, d: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);

export function sanitizarParams(b: any): Params {
  const P = PARAMS_PADRAO;
  const fp = (v: unknown, d: number) => n(v, d, 0.8, 1) as number;
  return {
    d_contr_g_kw: n(b.d_contr_g_kw, null, 0), alvo_g_pct: n(b.alvo_g_pct, P.alvo_g_pct, 50, 100) as number,
    d_contr_c_kw: n(b.d_contr_c_kw, null, 0), d_contr_c_ponta_kw: n(b.d_contr_c_ponta_kw, null, 0),
    alvo_c_pct: n(b.alvo_c_pct, P.alvo_c_pct, 50, 100) as number,
    fp_lim_ind: fp(b.fp_lim_ind, P.fp_lim_ind), fp_lim_cap: fp(b.fp_lim_cap, P.fp_lim_cap),
    fp_alvo_ind: fp(b.fp_alvo_ind, P.fp_alvo_ind), fp_alvo_cap: fp(b.fp_alvo_cap, P.fp_alvo_cap),
    janela_cap_ini: hhmm(b.janela_cap_ini, P.janela_cap_ini), janela_cap_fim: hhmm(b.janela_cap_fim, P.janela_cap_fim),
    margem_q3_kvar: n(b.margem_q3_kvar, P.margem_q3_kvar, 0) as number,
    banda_pct: n(b.banda_pct, P.banda_pct, 0, 20) as number,
    t_min_ajuste_fp_s: n(b.t_min_ajuste_fp_s, P.t_min_ajuste_fp_s, 60, 3600) as number,
    t_resposta_s: n(b.t_resposta_s, P.t_resposta_s, 5, 600) as number,
    degrau_min_pct: n(b.degrau_min_pct, P.degrau_min_pct, 0.5, 20) as number,
    t_validade_internet_s: n(b.t_validade_internet_s, P.t_validade_internet_s, 60, 3600) as number,
    t_validade_lora_s: n(b.t_validade_lora_s, P.t_validade_lora_s, 60, 3600) as number,
    t_estagio2_s: n(b.t_estagio2_s, P.t_estagio2_s, 0, 86400) as number,
    n_retomada: Math.round(n(b.n_retomada, P.n_retomada, 1, 20) as number),
    ssu_err_max_min: n(b.ssu_err_max_min, P.ssu_err_max_min, 0, 60) as number,
    idade_max_ssu_s: n(b.idade_max_ssu_s, P.idade_max_ssu_s, 60, 900) as number,
    idade_max_inv_internet_s: n(b.idade_max_inv_internet_s, P.idade_max_inv_internet_s, 30, 900) as number,
    idade_max_inv_lora_s: n(b.idade_max_inv_lora_s, P.idade_max_inv_lora_s, 60, 1800) as number,
  };
}

export function sanitizarUfvs(lista: any): Ufv[] {
  if (!Array.isArray(lista)) throw new BadRequestException('UFVs: lista inválida.');
  const vistos = new Set<string>();
  return lista.slice(0, 50).map((u: any, k: number) => {
    const inversores = (Array.isArray(u?.inversores) ? u.inversores : []).map((i: any) => {
      const id = String(i?.id ?? '').trim();
      if (!id) throw new BadRequestException(`UFV ${u?.nome ?? k + 1}: inversor sem id.`);
      if (vistos.has(id)) throw new BadRequestException(`Inversor ${i?.nome ?? id} está em mais de uma UFV.`);
      vistos.add(id);
      return {
        id, nome: String(i?.nome ?? '').trim() || undefined,
        pn_kw: n(i?.pn_kw, 0, 0) as number, smax_kva: n(i?.smax_kva, 0, 0) as number,
        qmax_pct: n(i?.qmax_pct, 44, 0, 100) as number,
        sinal_q: Number(i?.sinal_q) === -1 ? -1 : 1,
        q_noturno: i?.q_noturno === true,
      };
    });
    return {
      id: String(u?.id ?? '').trim() || `ufv${k + 1}`,
      nome: String(u?.nome ?? '').trim() || `UFV ${k + 1}`,
      ordem: Math.round(n(u?.ordem, k + 1, 1, 99) as number),
      p_estatico_kw: n(u?.p_estatico_kw, 0, 0) as number,
      zera_estagio2: u?.zera_estagio2 === true,
      watchdog_nativo: u?.watchdog_nativo === true,
      rota: u?.rota === 'lora' ? 'lora' : 'internet',
      inversores,
    } as Ufv;
  });
}

function resumoConfig(antes: Params | undefined, depois: Params, ufvsAntes: Ufv[], ufvsDepois: Ufv[]): string {
  const mud = antes ? (Object.keys(depois) as Array<keyof Params>).filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(depois[k])) : ['cadastro inicial'];
  const u = JSON.stringify(ufvsAntes) !== JSON.stringify(ufvsDepois) ? [`UFVs (${ufvsDepois.length})`] : [];
  return [...mud, ...u].join(', ') || 'sem mudança';
}
