import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@/core';
import { colunaTrilhaAusente } from '../logs-mqtt/logs-mqtt-filtros';
import { PivoSequenciaService } from './pivo-sequencia.service';
import { parametrosEncoder } from './pivo-posicao.util';
import {
  AcompanhaSentido,
  AcompanhaTravado,
  passoSentido,
  passoTravado,
  prazoTravadoMs,
  TRAVADO_MIN_PADRAO,
} from './pivo-calibracao.util';

/** Chave do advisory lock deste tick (diferente da do PivoAutomacaoService). */
const LOCK_KEY = 71_103_001;
/**
 * Encoder sem resposta: a TON pausa o encoder depois de 3 leituras seguidas com erro ou
 * timeout e para de publicar. Aqui isso aparece como falta de leitura nova com a TON viva.
 * A leitura chega a cada 60 s e é gravada com até 1 min de atraso (buffer): 5 min sem
 * leitura nova não é atraso normal.
 */
const ENCODER_MUDO_MS = 5 * 60_000;
/** TON "viva": publicou o status do pivô há menos que isto (ela publica a cada 60 s parada). */
const TON_VIVA_MS = 150_000;

export type CodigoAlarmeAngulo = 'encoder_sem_resposta' | 'sentido_invertido' | 'pivo_travado';

interface Aberto { id: string; snapshot: Record<string, any> }

/**
 * Alarmes do ângulo do pivô (NEXON-103, seção 7): encoder sem resposta, sentido invertido
 * e pivô travado. ("Sem calibração" não é alarme: é o estado `posicao.sem_calibracao`,
 * em que a tela mostra só o valor bruto, com aviso.)
 *
 * Tick de 30 s só nos pivôs com encoder na Configuração. Cada alarme é uma linha em
 * logs_mqtt (tipo 'alerta', dados_snapshot.kind = 'pivo_angulo', .codigo) — aparece na lista
 * de alarmes como os demais. Um aberto por pivô e código; resolve sozinho quando a condição
 * some (o de sentido invertido só resolve ao recalibrar).
 */
@Injectable()
export class PivoAnguloAlarmeService {
  private readonly logger = new Logger('PivoAnguloAlarme');
  private rodando = false;
  private readonly sentido = new Map<string, AcompanhaSentido>();
  private readonly travado = new Map<string, AcompanhaTravado>();

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
        await this.avaliarTodos();
      } finally {
        await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
      }
    } catch (e: any) {
      if (!colunaTrilhaAusente(e)) this.logger.warn(`[pivo-angulo] tick: ${e?.message ?? e}`);
    } finally {
      this.rodando = false;
    }
  }

  /** Pivôs com encoder na Configuração — os únicos em que estes alarmes fazem sentido. */
  async avaliarTodos(agora = Date.now()) {
    const pivos = await this.prisma.$queryRaw<Array<{ id: string; nome: string; parametros: any }>>`
      SELECT TRIM(c.equipamento_id) AS id, e.nome, c.parametros
      FROM pivo_config c
      JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      WHERE COALESCE(c.parametros->>'encoder_equipamento_id', '') <> ''`;
    if (!pivos.length) return;
    const abertos = await this.abertos();
    for (const p of pivos) {
      try {
        await this.avaliar(p, abertos, agora);
      } catch (e: any) {
        this.logger.warn(`[pivo-angulo] ${p.id}: ${e?.message ?? e}`);
      }
    }
  }

  private async avaliar(p: { id: string; nome: string; parametros: any }, abertos: Map<string, Aberto>, agora: number) {
    const nome = p.nome?.trim() || 'Pivô';
    const enc = parametrosEncoder(p.parametros);
    const pos = await this.seq.posicao(p.id);
    const giro = await this.seq.giroAtual(p.id);
    const chave = (c: CodigoAlarmeAngulo) => `${p.id}|${c}`;

    // ---- Encoder sem resposta
    const tonViva = !!giro.ton && agora - new Date(giro.ton.em).getTime() <= TON_VIVA_MS;
    const idadeMs = pos.lido_em ? agora - new Date(pos.lido_em).getTime() : null;
    const mudo = idadeMs === null || idadeMs > ENCODER_MUDO_MS;
    const abertoEnc = abertos.get(chave('encoder_sem_resposta'));
    if (enc.resolucao && tonViva && mudo && !abertoEnc) {
      await this.abrir(p.id, 'encoder_sem_resposta', `${nome}: encoder sem resposta`, 'ALTA', {
        ultima_leitura: pos.lido_em ?? null,
        detalhe: idadeMs === null ? 'A TON nunca publicou leitura deste encoder' : `Sem leitura nova há ${Math.round(idadeMs / 60_000)} min, com a TON online`,
      });
    } else if (abertoEnc && !mudo) {
      await this.resolver(abertoEnc, { normalizado_por: 'Encoder voltou a responder' });
    }

    // Os dois seguintes precisam do ângulo calibrado e do lado lido das entradas.
    const angulo = pos.fonte === 'encoder' && !pos.sem_calibracao ? pos.angulo : null;

    // ---- Sentido invertido (comando de um lado e o ângulo andando para o outro)
    const s = passoSentido(this.sentido.get(p.id) ?? null, giro.dir, angulo);
    if (s.estado) this.sentido.set(p.id, s.estado); else this.sentido.delete(p.id);
    if (s.invertido) {
      if (!abertos.get(chave('sentido_invertido'))) {
        await this.abrir(p.id, 'sentido_invertido', `${nome}: Sentido invertido — recalibrar`, 'ALTA', {
          comando: giro.dir === 'D' ? 'direita' : 'esquerda', graus_no_contrario: s.contrario, angulo,
          detalhe: `Comando ${giro.dir === 'D' ? 'Direita' : 'Esquerda'} ativo e o ângulo andou ${String(s.contrario).replace('.', ',')}° no sentido contrário`,
        });
      }
      // recomeça a conta: só alarma de novo se andar mais 2° ao contrário depois de resolvido
      if (s.estado) this.sentido.set(p.id, { ...s.estado, acumulado: 0 });
    }

    // ---- Pivô travado (girando com o ângulo parado)
    const minutos = Number(p.parametros?.travado_min) > 0 ? Number(p.parametros.travado_min) : TRAVADO_MIN_PADRAO;
    const volta100 = Number(p.parametros?.tempo_volta_100) >= 1 ? Number(p.parametros.tempo_volta_100) : null;
    const prazo = prazoTravadoMs(minutos, enc.resolucao, volta100, giro.percentual);
    const t = passoTravado(this.travado.get(p.id) ?? null, giro.dir !== null, angulo, agora, prazo, enc.resolucao);
    if (t.estado) this.travado.set(p.id, t.estado); else this.travado.delete(p.id);
    const abertoTrav = abertos.get(chave('pivo_travado'));
    if (t.travado && !abertoTrav) {
      await this.abrir(p.id, 'pivo_travado', `${nome}: pivô travado — girando há ${Math.round(t.paradoMs / 60_000)} min sem o ângulo mudar`, 'ALTA', {
        angulo, prazo_min: Math.round(prazo / 60_000), configurado_min: minutos, percentual: giro.percentual,
        detalhe: `Contator de força ligado e ângulo parado em ${angulo}° por ${Math.round(t.paradoMs / 60_000)} min`,
      });
    } else if (abertoTrav && !t.travado && (giro.dir === null ? giro.lido : t.paradoMs === 0 && angulo != null)) {
      await this.resolver(abertoTrav, { normalizado_por: giro.dir === null ? 'Pivô parou' : 'Pivô voltou a andar' });
    }
  }

  private async abertos(): Promise<Map<string, Aberto>> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id, dados_snapshot
      FROM logs_mqtt
      WHERE tipo = 'alerta' AND resolvido_em IS NULL AND (dados_snapshot->>'kind') = 'pivo_angulo'`;
    return new Map(rows.map((r) => [`${r.equipamento_id}|${r.dados_snapshot?.codigo}`, { id: r.id, snapshot: r.dados_snapshot ?? {} }]));
  }

  private async abrir(equipamentoId: string, codigo: CodigoAlarmeAngulo, mensagem: string, severidade: 'MEDIA' | 'ALTA' | 'CRITICA', extra: Record<string, unknown>) {
    await this.prisma.logs_mqtt.create({
      data: {
        tipo: 'alerta', equipamento_id: equipamentoId, mensagem: mensagem.slice(0, 500), severidade,
        dados_snapshot: { kind: 'pivo_angulo', codigo, desde: new Date().toISOString(), ...extra } as any,
      },
    });
    this.logger.warn(`[pivo-angulo] alarme aberto: ${mensagem}`);
  }

  private async resolver(a: Aberto, extra: Record<string, unknown>) {
    const snap = { ...a.snapshot, normalizado_em: new Date().toISOString(), ...extra };
    await this.prisma.$executeRaw`
      UPDATE logs_mqtt SET resolvido_em = now(), dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${a.id}`;
  }
}
