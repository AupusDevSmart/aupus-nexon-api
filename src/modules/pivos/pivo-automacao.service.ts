import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@/core';
import { FUSO_OPERACAO, momentoEmSaoPaulo } from '../../shared/util/janela-horario';
import { AcaoPivo, PivoSequenciaService } from './pivo-sequencia.service';
import {
  chegouNoAngulo, dentroDaPonta, Irrigacao, irrigacaoDaProgramacao, programacaoDisparaAgora, ProgramacaoExec, resumoIrrigacao,
} from './pivo-automacao.util';

/**
 * Automação do pivô — o servidor executando sozinho o que a ficha configurou:
 *
 *  1. Início agendado ("Início" da Irrigação avançada): sequência 'agendada' → liga na hora.
 *  2. Programação de horários (pivo_programacoes): liga no dia/hora e para pelo tempo
 *     ou percurso (parar_em).
 *  3. Parada automática: irrigação com parar_em vencido → Desligar. Parada por ângulo
 *     sem previsão → para quando o ângulo lido chega ao destino.
 *  4. Bloqueio de ponta ("Pausa a irrigação e retoma ao fim da ponta"): no início da
 *     ponta desliga o que está irrigando e guarda o que retomar; no fim religa com a
 *     mesma irrigação e o tempo que faltava.
 *
 * Tick de 30 s com pg_try_advisory_lock: com mais de um processo no mesmo banco
 * (produção + staging, pm2 cluster) só um executa. Toda ação vira linha na trilha
 * (logs_mqtt tipo 'comando', comando_semantico 'pivo.<origem>') com o responsável.
 */
const LOCK_KEY = 5_150_001; // pivo-automacao

@Injectable()
export class PivoAutomacaoService {
  private readonly logger = new Logger(PivoAutomacaoService.name);
  private rodando = false;
  /** último ângulo lido por pivô (parada por ângulo sem previsão) */
  private readonly ultimoAngulo = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: PivoSequenciaService,
  ) {}

  @Interval(30_000)
  async tick() {
    if (this.rodando || process.env.PIVO_AUTOMACAO === 'off') return;
    this.rodando = true;
    try {
      const lock = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`;
      if (!lock[0]?.ok) return;
      try {
        await this.agendadas();
        await this.programacoes();
        await this.ponta();
        await this.paradas();
      } finally {
        await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
      }
    } catch (e: any) {
      // tabelas/colunas do SQL ausentes não podem derrubar o processo
      this.logger.warn(`[pivo-automacao] tick: ${e?.message}`);
    } finally {
      this.rodando = false;
    }
  }

  // 1 ---------------------------------------------------------------- agendadas
  private async agendadas() {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; pivo: string; acao: AcaoPivo; irrigacao: Irrigacao | null; usuario_id: string | null; inicio_em: Date }>>`
      SELECT TRIM(id) AS id, TRIM(equipamento_id) AS pivo, acao, irrigacao, TRIM(usuario_id) AS usuario_id, inicio_em
      FROM pivo_sequencias WHERE status = 'agendada' AND inicio_em <= now() ORDER BY inicio_em`;
    for (const r of rows) {
      await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET status = 'cancelada', finished_at = now(), erro = 'Disparada pelo agendamento'
        WHERE id = ${r.id} AND status = 'agendada'`;
      if (Date.now() - new Date(r.inicio_em).getTime() > 30 * 60000) {
        await this.seq.trilha(r.pivo, `Início agendado para ${this.hora(r.inicio_em)} perdido (servidor fora do ar) — não liguei`, r.usuario_id, 'agendada', 'WARN');
        continue;
      }
      await this.ligar(r.pivo, r.acao, r.irrigacao, r.usuario_id, 'agendada', `agendado para ${this.hora(r.inicio_em)}`);
    }
  }

  // 2 ------------------------------------------------------------- programações
  private async programacoes() {
    const progs = await this.prisma.$queryRaw<Array<ProgramacaoExec & { pivo: string; created_by: string | null }>>`
      SELECT TRIM(p.id) AS id, TRIM(p.equipamento_id) AS pivo, p.nome, p.ativo, p.hora_inicio, p.dias, p.modo,
             p.angulo_inicial::float AS angulo_inicial, p.angulo_final::float AS angulo_final, p.duracao_min, p.sentido,
             p.velocidade::float AS velocidade, p.com_agua, p.ultima_execucao_em, TRIM(COALESCE(p.updated_by, p.created_by)) AS created_by
      FROM pivo_programacoes p JOIN equipamentos e ON e.id = p.equipamento_id AND e.deleted_at IS NULL
      WHERE p.deleted_at IS NULL AND p.ativo`;
    const agora = momentoEmSaoPaulo();
    for (const p of progs) {
      if (!programacaoDisparaAgora({ ...p, dias: (p.dias ?? []).map(Number) }, agora, Date.now())) continue;
      await this.prisma.$executeRaw`UPDATE pivo_programacoes SET ultima_execucao_em = now() WHERE TRIM(id) = ${p.id}`;
      if (await this.seq.irrigacaoAtiva(p.pivo)) {
        await this.seq.trilha(p.pivo, `"${p.nome}" não ligou: o pivô já está irrigando`, p.created_by, 'programacao', 'WARN');
        continue;
      }
      const irr = irrigacaoDaProgramacao(p);
      await this.ligar(p.pivo, irr.config.direcao === 'Avanço' ? 'girar_direita' : 'girar_esquerda', irr, p.created_by, 'programacao', `"${p.nome}"`);
    }
  }

  // 3 ---------------------------------------------------------------- paradas
  private async paradas() {
    const rows = await this.prisma.$queryRaw<Array<{ pivo: string }>>`
      SELECT DISTINCT TRIM(s.equipamento_id) AS pivo FROM pivo_sequencias s
      WHERE s.status = 'concluida' AND s.acao <> 'desligar' AND s.irrigacao IS NOT NULL
        AND s.created_at > now() - interval '14 days'
        AND (s.parar_em IS NOT NULL OR s.irrigacao->'parada'->>'tipo' = 'porAngulo')`;
    for (const { pivo } of rows) {
      const at = await this.seq.irrigacaoAtiva(pivo);
      if (!at?.irrigacao) continue;
      const irr = at.irrigacao;
      if (at.parar_em && new Date(at.parar_em).getTime() <= Date.now()) {
        await this.desligar(pivo, at.usuario_id, 'parada', `fim previsto (${this.paradaTxt(irr)})`);
        continue;
      }
      if (!at.parar_em && irr.parada.tipo === 'porAngulo') {
        const ang = await this.seq.anguloAtual(pivo);
        if (ang == null) continue;
        const ant = this.ultimoAngulo.get(pivo) ?? ang;
        this.ultimoAngulo.set(pivo, ang);
        if (chegouNoAngulo(irr.config.direcao, irr.parada.angulo, ant, ang)) {
          this.ultimoAngulo.delete(pivo);
          await this.desligar(pivo, at.usuario_id, 'parada', `chegou em ${Math.round(ang)}° (destino ${irr.parada.angulo}°)`);
        }
      }
    }
  }

  // 4 ------------------------------------------------------------------ ponta
  private async ponta() {
    const cfgs = await this.prisma.$queryRaw<Array<{ pivo: string; ponta: any }>>`
      SELECT TRIM(c.equipamento_id) AS pivo, c.bloqueio_ponta AS ponta FROM pivo_config c
      JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      WHERE (c.bloqueio_ponta->>'ativo')::boolean IS TRUE`;
    const agora = momentoEmSaoPaulo();
    for (const c of cfgs) {
      const dentro = dentroDaPonta(c.ponta, agora);
      if (dentro) {
        const at = await this.seq.irrigacaoAtiva(c.pivo);
        if (!at) continue;
        const restante = at.parar_em ? Math.max(0, new Date(at.parar_em).getTime() - Date.now()) : null;
        await this.seq.acionar(c.pivo, 'desligar', undefined, undefined, {
          origem: 'ponta', responsavelId: at.usuario_id, motivo: `pausa ${c.ponta.inicio}–${c.ponta.fim}, retoma às ${c.ponta.fim}`,
          retomar: { irrigacao: at.irrigacao, acao: at.acao, restante_ms: restante },
        }).catch((e) => this.falhou(c.pivo, 'Pausa da ponta', e, at.usuario_id, 'ponta'));
        continue;
      }
      // Fora da ponta: a última sequência é a pausa da ponta? Retoma.
      const ult = await this.prisma.$queryRaw<Array<{ origem: string; acao: string; retomar: any; usuario_id: string | null; created_at: Date }>>`
        SELECT origem, acao, retomar, TRIM(usuario_id) AS usuario_id, created_at FROM pivo_sequencias
        WHERE equipamento_id = ${c.pivo}::bpchar AND status NOT IN ('agendada', 'cancelada')
        ORDER BY created_at DESC LIMIT 1`;
      const u = ult[0];
      if (!u || u.origem !== 'ponta' || u.acao !== 'desligar' || !u.retomar) continue;
      if (Date.now() - new Date(u.created_at).getTime() > 12 * 3600000) continue; // pausa velha: não religa sozinho
      const r = u.retomar as { irrigacao: Irrigacao | null; acao: AcaoPivo; restante_ms: number | null };
      const irr: Irrigacao | null = r.irrigacao
        ? { ...r.irrigacao, parada: r.restante_ms != null ? { tipo: 'porTempo', minutos: Math.max(1, Math.round(r.restante_ms / 60000)) } : r.irrigacao.parada }
        : null;
      await this.ligar(c.pivo, r.acao, irr, u.usuario_id, 'ponta_retomada', `fim da ponta ${c.ponta.fim}`);
    }
  }

  // ------------------------------------------------------------------ apoio
  private async ligar(pivo: string, acao: AcaoPivo, irr: Irrigacao | null, responsavel: string | null, origem: 'agendada' | 'programacao' | 'ponta_retomada', motivo: string) {
    try {
      await this.seq.acionar(pivo, acao, undefined, undefined, { irrigacao: irr, origem, responsavelId: responsavel, motivo });
      this.logger.log(`[pivo-automacao] ${pivo} ${origem}: ligar · ${resumoIrrigacao(irr)}`);
    } catch (e) {
      await this.falhou(pivo, `Ligar (${motivo})`, e, responsavel, origem);
    }
  }

  private async desligar(pivo: string, responsavel: string | null, origem: 'parada', motivo: string) {
    try {
      await this.seq.acionar(pivo, 'desligar', undefined, undefined, { origem, responsavelId: responsavel, motivo });
      this.logger.log(`[pivo-automacao] ${pivo} ${origem}: desligar · ${motivo}`);
    } catch (e) {
      await this.falhou(pivo, `Desligar (${motivo})`, e, responsavel, origem);
    }
  }

  private async falhou(pivo: string, oque: string, e: any, responsavel: string | null, origem: 'agendada' | 'programacao' | 'ponta' | 'ponta_retomada' | 'parada') {
    const msg = e?.response?.message || e?.message || String(e);
    this.logger.warn(`[pivo-automacao] ${pivo} ${oque}: ${msg}`);
    await this.seq.trilha(pivo, `${oque} não executou: ${msg}`, responsavel, origem, 'ALTA');
  }

  private hora(d: Date) {
    return new Date(d).toLocaleString('pt-BR', { timeZone: FUSO_OPERACAO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  private paradaTxt(i: Irrigacao) {
    const p = i.parada;
    return p.tipo === 'porVoltas' ? `${p.voltas} volta(s)` : p.tipo === 'porTempo' ? `${p.minutos} min` : p.tipo === 'porAngulo' ? `ângulo ${p.angulo}°` : 'sem parada';
  }
}
