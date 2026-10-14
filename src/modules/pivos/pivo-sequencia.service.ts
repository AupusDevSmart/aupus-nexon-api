import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser, ClienteInfo } from '@/core';
import { novoId26 } from '../../core/common/cliente-info';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';

/**
 * Sequência do pivô com bombeamento (docs/IOT-PIVO-BOMBEAMENTO.md).
 *
 * O pivô e a bomba ficam em TONs diferentes; só o NexON enxerga as duas. Um clique
 * ("Girar ←/→" ou "Desligar") vira a sequência inteira:
 *
 *   Girar:    bomba já ligada? (BI) ── não → liga bomba → confirma BI → aguarda pressurização
 *             → pulso Girar_X no pivô → confirma status "Girando_X"
 *   Desligar: pulso Desligar no pivô → confirma parado → desliga a bomba SÓ se nenhum
 *             outro pivô da mesma bomba (mesma TON + BO de ligar) estiver girando
 *
 * Bombeamento = funcionalidade do pivô (pivo_config.bombeamento), não equipamento.
 * Comandos do pivô vão pelo acionarPonto (permissão, janela, ponta, trilha); os da bomba
 * pelo acionarBoDireto (mesmas restrições, trilha no pivô). Estado persistido em
 * pivo_sequencias; a ficha acompanha por GET /pivos/:id/estado.
 */

export type AcaoPivo = 'girar_direita' | 'girar_esquerda' | 'desligar';

export interface Bombeamento {
  ativo: boolean;
  ton_id: string;
  modo: 'pulso' | 'mantido';
  bo_liga: number;
  bo_desliga?: number | null;
  bi_confirma?: number | null;
  confirma_s?: number;
  pulso_ms?: number;
}
export interface SequenciaCfg { pressurizacao_s: number; confirma_giro_s: number }

interface Passo { t: string; etapa: string; msg: string; ok: boolean | null }
type Autor = ScopedUser & { nome?: string };

const SEQ_PADRAO: SequenciaCfg = { pressurizacao_s: 120, confirma_giro_s: 30 };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Pontos do pivô por papel, achados pelo nome (Girar_direita, Girando_esquerda, Desligado, Erro…). */
const PAPEIS_COMANDO: Record<'direita' | 'esquerda' | 'desligar', RegExp> = {
  direita: /direit|horario(?!.*anti)/,
  esquerda: /esquerd|anti.?horario/,
  desligar: /deslig|parar|stop/,
};
const PAPEIS_STATUS: Record<'direita' | 'esquerda' | 'desligado' | 'erro', RegExp> = {
  direita: /direit/,
  esquerda: /esquerd/,
  desligado: /deslig|parad/,
  erro: /erro|falha/,
};

@Injectable()
export class PivoSequenciaService implements OnModuleInit {
  private readonly logger = new Logger(PivoSequenciaService.name);
  /** sequências em execução neste processo: pivoId → flag de cancelamento */
  private readonly rodando = new Map<string, { seqId: string; cancelar: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly cmd: EquipamentosCmdService,
  ) {}

  async onModuleInit() {
    // processo reiniciou no meio de uma sequência: não há como retomar com segurança
    await this.prisma.$executeRaw`
      UPDATE pivo_sequencias SET status = 'interrompida', finished_at = now(),
        erro = COALESCE(erro, 'Servidor reiniciado durante a sequência')
      WHERE status = 'executando'`.catch(() => undefined);
  }

  // ------------------------------------------------------------------ config
  async lerConfig(pivoId: string): Promise<{ bombeamento: Bombeamento | null; sequencia: SequenciaCfg }> {
    const rows = await this.prisma.$queryRaw<Array<{ bombeamento: any; sequencia: any }>>`
      SELECT bombeamento, sequencia FROM pivo_config WHERE equipamento_id = ${pivoId}::bpchar LIMIT 1`;
    const b = rows[0]?.bombeamento;
    const s = rows[0]?.sequencia ?? {};
    return {
      bombeamento: b && b.ton_id && b.bo_liga ? (b as Bombeamento) : null,
      sequencia: {
        pressurizacao_s: Number.isFinite(Number(s.pressurizacao_s)) ? Number(s.pressurizacao_s) : SEQ_PADRAO.pressurizacao_s,
        confirma_giro_s: Number(s.confirma_giro_s) || SEQ_PADRAO.confirma_giro_s,
      },
    };
  }

  async salvarConfig(pivoId: string, body: { bombeamento?: Partial<Bombeamento> | null; sequencia?: Partial<SequenciaCfg> }, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    let bomb: Bombeamento | null = null;
    if (body.bombeamento && body.bombeamento.ativo !== false) {
      const b = body.bombeamento;
      const inteiro = (v: any, nome: string, obrig = false) => {
        if (v === null || v === undefined || v === '') {
          if (obrig) throw new BadRequestException(`Bombeamento: informe ${nome}.`);
          return null;
        }
        const n = Math.trunc(Number(v));
        if (!(n >= 1 && n <= 16)) throw new BadRequestException(`Bombeamento: ${nome} inválido (${v}).`);
        return n;
      };
      if (!b.ton_id) throw new BadRequestException('Bombeamento: escolha a TON da bomba.');
      const ton = await this.prisma.equipamentos.findFirst({ where: { id: String(b.ton_id).trim(), deleted_at: null }, select: { id: true } });
      if (!ton) throw new BadRequestException('Bombeamento: TON não encontrada.');
      if (user) await this.scope.assertEntityInScope('equipamento', ton.id.trim(), user);
      const modo = b.modo === 'mantido' ? 'mantido' : 'pulso';
      bomb = {
        ativo: true,
        ton_id: ton.id.trim(),
        modo,
        bo_liga: inteiro(b.bo_liga, 'a BO de ligar', true)!,
        bo_desliga: modo === 'pulso' ? inteiro(b.bo_desliga, 'a BO de desligar', true) : null,
        bi_confirma: inteiro(b.bi_confirma, 'a BI de confirmação'),
        confirma_s: Math.max(5, Math.min(300, Number(b.confirma_s) || 30)),
        pulso_ms: Math.max(100, Math.min(10000, Number(b.pulso_ms) || 1000)),
      };
      if (bomb.modo === 'pulso' && bomb.bo_desliga === bomb.bo_liga) {
        throw new BadRequestException('Bombeamento por pulso: a BO de desligar tem de ser diferente da de ligar.');
      }
    }
    const atual = await this.lerConfig(id);
    const seq: SequenciaCfg = {
      pressurizacao_s: Math.max(0, Math.min(900, Number(body.sequencia?.pressurizacao_s ?? atual.sequencia.pressurizacao_s))),
      confirma_giro_s: Math.max(5, Math.min(300, Number(body.sequencia?.confirma_giro_s ?? atual.sequencia.confirma_giro_s))),
    };
    const bombJson = body.bombeamento === undefined ? (atual.bombeamento ? JSON.stringify(atual.bombeamento) : null) : bomb ? JSON.stringify(bomb) : null;
    await this.prisma.$executeRaw`
      INSERT INTO pivo_config (equipamento_id, bombeamento, sequencia, updated_at, updated_by)
      VALUES (${id}::bpchar, ${bombJson}::jsonb, ${JSON.stringify(seq)}::jsonb, now(), ${user?.id?.trim() || null})
      ON CONFLICT (equipamento_id) DO UPDATE SET bombeamento = EXCLUDED.bombeamento, sequencia = EXCLUDED.sequencia,
        updated_at = now(), updated_by = EXCLUDED.updated_by`;
    return this.estado(id, user);
  }

  /** TONs da mesma planta (para escolher a da bomba) + bombeamentos de outros pivôs (atalho "usar o do Pivô X"). */
  async opcoes(pivoId: string, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    const tons = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(t.id) AS id, TRIM(t.nome) AS nome, TRIM(t.topico_mqtt) AS topico, TRIM(u.nome) AS unidade
      FROM equipamentos p
      JOIN unidades up ON up.id = p.unidade_id
      JOIN unidades u ON u.planta_id = up.planta_id AND u.deleted_at IS NULL
      JOIN equipamentos t ON t.unidade_id = u.id AND t.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos te ON te.id = t.tipo_equipamento_id
      WHERE p.id = ${id}::bpchar
        AND (te.codigo ILIKE 'TON%' OR t.tipo_equipamento ILIKE 'TON%')
      ORDER BY u.nome, t.nome`;
    const outros = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS pivo_id, TRIM(e.nome) AS nome, c.bombeamento
      FROM pivo_config c
      JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      JOIN unidades u ON u.id = e.unidade_id
      WHERE c.bombeamento IS NOT NULL AND c.equipamento_id <> ${id}::bpchar
        AND u.planta_id = (SELECT u2.planta_id FROM equipamentos p2 JOIN unidades u2 ON u2.id = p2.unidade_id WHERE p2.id = ${id}::bpchar)
      ORDER BY e.nome`;
    return { tons, bombeamentos: outros };
  }

  // ------------------------------------------------------------------ estado
  async estado(pivoId: string, user?: Autor) {
    const id = await this.assertPivo(pivoId, user);
    const cfg = await this.lerConfig(id);
    const pts = await this.pontos(id);
    const st = await this.statusPivo(pts);
    let bomba: any = null;
    if (cfg.bombeamento) {
      const b = cfg.bombeamento;
      const ton = await this.prisma.equipamentos.findFirst({ where: { id: b.ton_id }, select: { nome: true, deleted_at: true } });
      const ligada = b.bi_confirma ? await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma) : null;
      const comp = await this.companheiros(id, b);
      bomba = {
        ...b,
        ton_nome: ton?.nome?.trim() ?? null,
        ton_removida: !ton || !!ton.deleted_at,
        ligada: ligada?.valor ?? null,
        ligada_em: ligada?.updated_at ?? null,
        compartilhada_com: comp.map((c) => c.nome),
      };
    }
    const seq = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, acao, status, passos, erro, created_at, finished_at
      FROM pivo_sequencias WHERE equipamento_id = ${id}::bpchar ORDER BY created_at DESC LIMIT 1`;
    return {
      pivo: {
        comandos: { direita: !!pts.cmd.direita, esquerda: !!pts.cmd.esquerda, desligar: !!pts.cmd.desligar },
        status: st,
      },
      bombeamento: bomba,
      sequencia_cfg: cfg.sequencia,
      sequencia: seq[0] ?? null,
    };
  }

  // ------------------------------------------------------------------ acionar
  async acionar(pivoId: string, acao: AcaoPivo, user?: Autor, cliente?: ClienteInfo) {
    if (!['girar_direita', 'girar_esquerda', 'desligar'].includes(acao)) {
      throw new BadRequestException('Ação inválida (girar_direita | girar_esquerda | desligar).');
    }
    const id = await this.assertPivo(pivoId, user);
    const eq = await this.prisma.equipamentos.findFirst({ where: { id }, select: { nome: true, automacao: true } });
    if (!eq?.automacao) throw new BadRequestException(`"${eq?.nome?.trim()}" não tem automação habilitada.`);
    const pts = await this.pontos(id);
    const papel = acao === 'girar_direita' ? 'direita' : acao === 'girar_esquerda' ? 'esquerda' : 'desligar';
    if (!pts.cmd[papel] && !(acao === 'desligar' && (await this.lerConfig(id)).bombeamento)) {
      throw new BadRequestException(`O pivô não tem o comando "${papel}" cadastrado (ponto de comando ligado a uma BO).`);
    }

    const atual = this.rodando.get(id);
    if (atual) {
      if (acao !== 'desligar') throw new ConflictException('Já existe uma sequência em andamento neste pivô. Use Desligar para interromper.');
      atual.cancelar = true;   // Desligar sempre pode: interrompe a partida em curso
      for (let i = 0; i < 40 && this.rodando.has(id); i++) await this.sleep(250);
    }

    const seqId = novoId26();
    await this.prisma.$executeRaw`
      INSERT INTO pivo_sequencias (id, equipamento_id, acao, status, usuario_id)
      VALUES (${seqId}, ${id}::bpchar, ${acao}, 'executando', ${user?.id?.trim() || null})`;
    const ctl = { seqId, cancelar: false };
    this.rodando.set(id, ctl);
    void this.executar(id, acao, ctl, user, cliente).finally(() => {
      if (this.rodando.get(id) === ctl) this.rodando.delete(id);
    });
    return { sequencia_id: seqId, status: 'executando' };
  }

  // ------------------------------------------------------------------ execução
  private async executar(id: string, acao: AcaoPivo, ctl: { seqId: string; cancelar: boolean }, user?: Autor, cliente?: ClienteInfo) {
    const passos: Passo[] = [];
    const passo = async (etapa: string, msg: string, ok: boolean | null) => {
      passos.push({ t: new Date().toISOString(), etapa, msg, ok });
      await this.prisma.$executeRaw`UPDATE pivo_sequencias SET passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const fim = async (status: 'concluida' | 'falhou' | 'interrompida', erro?: string) => {
      await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET status = ${status}, erro = ${erro ?? null}, finished_at = now(),
          passos = ${JSON.stringify(passos)}::jsonb WHERE id = ${ctl.seqId}`;
    };
    const msgErro = (e: any) => e?.response?.message || e?.message || String(e);

    try {
      const cfg = await this.lerConfig(id);
      const pts = await this.pontos(id);
      const b = cfg.bombeamento;

      if (acao === 'desligar') {
        if (pts.cmd.desligar) {
          await this.cmd.acionarPonto(id, pts.cmd.desligar, user, false, undefined, cliente);
          await passo('pivo', 'Comando Desligar enviado ao pivô', true);
          const parou = await this.esperar(async () => {
            const s = await this.statusPivo(pts);
            if (s.desligado === 1) return true;
            if (s.direita === 0 && s.esquerda === 0) return true;
            return s.desligado === null && s.direita === null && s.esquerda === null ? null : false;
          }, cfg.sequencia.confirma_giro_s, ctl);
          await passo('pivo', parou === null ? 'Pivô sem status cadastrado — sem confirmação' : parou ? 'Pivô parado' : 'Pivô não confirmou parada no tempo', parou !== false);
        }
        if (b) await this.desligarBomba(id, b, passo, user, cliente);
        await fim('concluida');
        return;
      }

      // ---- girar
      const sentido = acao === 'girar_direita' ? 'direita' : 'esquerda';
      const st0 = await this.statusPivo(pts);
      if (st0.erro === 1) throw new Error('Pivô sinalizando ERRO — verifique no painel antes de partir.');

      let liguei = false;
      if (b) {
        const ligada = b.bi_confirma ? (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma)).valor : null;
        if (ligada === 1) {
          await passo('bomba', 'Bomba já ligada (sistema compartilhado) — sem esperar pressurização', true);
        } else {
          await this.cmd.acionarBoDireto(
            { equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: b.modo === 'mantido' ? 'liga' : 'pulso', pulsoMs: b.pulso_ms, rotulo: 'Ligar bomba' },
            user, cliente,
          );
          liguei = true;
          await passo('bomba', 'Comando Ligar bomba enviado', true);
          if (b.bi_confirma) {
            const ok = await this.esperar(async () => (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma!)).valor === 1, b.confirma_s ?? 30, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            if (!ok) throw new FalhaBomba(`Bomba não confirmou ligada em ${b.confirma_s ?? 30}s (BI${b.bi_confirma}).`);
            await passo('bomba', 'Bomba ligada (confirmado pela BI)', true);
          } else {
            await passo('bomba', 'Sem BI de confirmação da bomba — seguindo', null);
          }
          const pressS = cfg.sequencia.pressurizacao_s;
          if (pressS > 0) {
            await passo('pressao', `Aguardando pressurização (${pressS}s)`, null);
            await this.esperar(async () => false, pressS, ctl);
            if (ctl.cancelar) return await this.interrompida(passo, fim);
            await passo('pressao', 'Pressurização concluída', true);
          }
        }
      }

      if (ctl.cancelar) return await this.interrompida(passo, fim);
      await this.cmd.acionarPonto(id, pts.cmd[sentido]!, user, false, undefined, cliente);
      await passo('pivo', `Comando Girar ${sentido} enviado ao pivô`, true);
      const girou = await this.esperar(async () => {
        const s = await this.statusPivo(pts);
        return s[sentido] === null ? null : s[sentido] === 1;
      }, cfg.sequencia.confirma_giro_s, ctl);
      if (ctl.cancelar) return await this.interrompida(passo, fim);
      if (girou === false) {
        throw new FalhaGiro(`Pivô não confirmou "girando ${sentido}" em ${cfg.sequencia.confirma_giro_s}s.`, liguei);
      }
      await passo('pivo', girou === null ? `Sem status de giro cadastrado — comando enviado` : `Pivô girando ${sentido}`, girou === null ? null : true);
      await fim('concluida');
    } catch (e: any) {
      await passo('erro', msgErro(e), false).catch(() => undefined);
      // falhou depois de ligar a bomba: não deixa bomba ligada à toa
      if ((e instanceof FalhaBomba || (e instanceof FalhaGiro && e.liguei)) && acao !== 'desligar') {
        const cfg = await this.lerConfig(id).catch(() => null);
        if (cfg?.bombeamento) await this.desligarBomba(id, cfg.bombeamento, passo, user, cliente).catch(() => undefined);
      }
      await fim('falhou', msgErro(e)).catch(() => undefined);
      this.logger.warn(`[pivo-seq] ${id} ${acao} falhou: ${msgErro(e)}`);
    }
  }

  private async interrompida(passo: (e: string, m: string, ok: boolean | null) => Promise<void>, fim: (s: any, e?: string) => Promise<void>) {
    await passo('fim', 'Interrompida pelo Desligar', null);
    await fim('interrompida');
  }

  /** Desliga a bomba se nenhum outro pivô da mesma bomba estiver girando. */
  private async desligarBomba(
    id: string, b: Bombeamento,
    passo: (e: string, m: string, ok: boolean | null) => Promise<void>,
    user?: Autor, cliente?: ClienteInfo,
  ) {
    const comp = await this.companheiros(id, b);
    const girando: string[] = [];
    for (const c of comp) {
      const s = await this.statusPivo(await this.pontos(c.id));
      if (s.direita === 1 || s.esquerda === 1 || (this.rodando.has(c.id))) girando.push(c.nome);
    }
    if (girando.length) {
      await passo('bomba', `Bomba mantida ligada: ${girando.join(', ')} ainda usando`, true);
      return;
    }
    await this.cmd.acionarBoDireto(
      b.modo === 'mantido'
        ? { equipamentoId: id, tonId: b.ton_id, bo: b.bo_liga, modo: 'desliga', rotulo: 'Desligar bomba' }
        : { equipamentoId: id, tonId: b.ton_id, bo: b.bo_desliga!, modo: 'pulso', pulsoMs: b.pulso_ms, rotulo: 'Desligar bomba' },
      user, cliente,
    );
    await passo('bomba', 'Comando Desligar bomba enviado', true);
    if (b.bi_confirma) {
      const ok = await this.esperar(async () => (await this.cmd.lerEntradaTon(b.ton_id, b.bi_confirma!)).valor === 0, b.confirma_s ?? 30, { cancelar: false });
      await passo('bomba', ok ? 'Bomba desligada (confirmado pela BI)' : `Bomba não confirmou desligada em ${b.confirma_s ?? 30}s`, !!ok);
    }
  }

  // ------------------------------------------------------------------ apoio
  /** Outros pivôs com a MESMA bomba (mesma TON + mesma BO de ligar). */
  private async companheiros(id: string, b: Bombeamento): Promise<Array<{ id: string; nome: string }>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome
      FROM pivo_config c JOIN equipamentos e ON e.id = c.equipamento_id AND e.deleted_at IS NULL
      WHERE c.equipamento_id <> ${id}::bpchar
        AND c.bombeamento->>'ton_id' = ${b.ton_id}
        AND (c.bombeamento->>'bo_liga')::int = ${Number(b.bo_liga)}
        AND COALESCE((c.bombeamento->>'ativo')::boolean, true)`;
    return rows;
  }

  private async pontos(id: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; tipo: string; nome: string; ton_id: string | null; bi: number | null; inv: boolean | null }>>`
      SELECT TRIM(p.id) AS id, p.tipo, p.nome, TRIM(b.ton_id) AS ton_id, b.bi_numero AS bi, b.invertido AS inv
      FROM equipamento_pontos p
      LEFT JOIN ton_bi b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      WHERE p.equipamento_id = ${id}::bpchar AND p.deleted_at IS NULL AND p.ativo
      ORDER BY p.ordem, p.nome`;
    const cmd: Partial<Record<'direita' | 'esquerda' | 'desligar', string>> = {};
    const st: Partial<Record<'direita' | 'esquerda' | 'desligado' | 'erro', { ton_id: string; bi: number; inv: boolean }>> = {};
    for (const r of rows) {
      const n = norm(r.nome);
      if (r.tipo === 'comando') {
        // ordem importa: "anti-horário" antes de "horário"
        for (const k of ['esquerda', 'direita', 'desligar'] as const) if (!cmd[k] && PAPEIS_COMANDO[k].test(n)) { cmd[k] = r.id; break; }
      } else if (r.tipo === 'status' && r.ton_id && r.bi) {
        for (const k of ['erro', 'desligado', 'esquerda', 'direita'] as const) if (!st[k] && PAPEIS_STATUS[k].test(n)) { st[k] = { ton_id: r.ton_id, bi: r.bi, inv: !!r.inv }; break; }
      }
    }
    return { cmd, st };
  }

  private async statusPivo(pts: { st: Partial<Record<string, { ton_id: string; bi: number; inv: boolean }>> }) {
    const out: Record<'direita' | 'esquerda' | 'desligado' | 'erro', 0 | 1 | null> = { direita: null, esquerda: null, desligado: null, erro: null };
    for (const k of Object.keys(out) as Array<keyof typeof out>) {
      const m = pts.st[k];
      if (!m) continue;
      const v = (await this.cmd.lerEntradaTon(m.ton_id, m.bi)).valor;
      out[k] = v === null ? null : ((m.inv ? 1 - v : v) as 0 | 1);
    }
    return out;
  }

  /** Espera a condição virar true (poll 1 s). null da condição = "não dá para saber" → devolve null já. */
  private async esperar(cond: () => Promise<boolean | null>, segundos: number, ctl: { cancelar: boolean }): Promise<boolean | null> {
    const limite = Date.now() + segundos * 1000;
    for (;;) {
      const r = await cond();
      if (r === null) return null;
      if (r) return true;
      if (ctl.cancelar || Date.now() >= limite) return false;
      await this.sleep(1000);
    }
  }

  private async assertPivo(pivoId: string, user?: Autor): Promise<string> {
    const id = String(pivoId).trim();
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    const eq = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, tipo_equipamento: true, tipo_equipamento_rel: { select: { codigo: true } } },
    });
    if (!eq) throw new NotFoundException('Pivô não encontrado');
    const cod = String(eq.tipo_equipamento_rel?.codigo ?? eq.tipo_equipamento ?? '').toUpperCase();
    if (!cod.includes('PIVO')) throw new BadRequestException('Equipamento não é um pivô.');
    return id;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

class FalhaBomba extends Error {}
class FalhaGiro extends Error {
  constructor(msg: string, readonly liguei: boolean) { super(msg); }
}
