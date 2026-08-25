import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';

/**
 * Carregador Elétrico (EV) — recarga por morador em condomínio.
 *
 * Fluxo: porteiro libera a recarga no nome do morador (ou tag identifica sozinha) →
 * a TON habilita o contator e mede kWh (medidor Modbus OU o próprio carregador no
 * broker) → ao DESCONECTAR, a TON/carregador corta o fornecimento e encerra a sessão.
 * Ociosidade: só conta a partir do momento em que OUTRO morador "pede a vaga" (o
 * porteiro registra no NexON). Export mensal: morador · kWh · ocioso · R$.
 *
 * Owner-scoped por planta. Ingestão MQTT (kWh + fim de sessão) fica no MqttService.
 */
@Injectable()
export class CarregadorEletricoService {
  private readonly logger = new Logger(CarregadorEletricoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly mqtt: MqttService,
  ) {}

  private genId(): string { return randomBytes(13).toString('hex'); }

  private async plantasDoUsuario(user?: ScopedUser): Promise<string[] | null> {
    if (!user) return null;
    const escopo = await this.scope.getScope(user);
    return this.scope.isScoped(escopo) ? escopo : null;
  }
  private async assertPlantaNoEscopo(user: ScopedUser | undefined, plantaId: string) {
    if (!user || !plantaId) return;
    const escopo = await this.scope.getScope(user);
    if (this.scope.isScoped(escopo) && !escopo.includes(plantaId.trim())) {
      throw new ForbiddenException('Fora do escopo');
    }
  }
  private async plantaDoCarregador(id: string): Promise<string | null> {
    const r = await this.prisma.$queryRaw<Array<{ planta_id: string }>>`
      SELECT TRIM(u.planta_id) AS planta_id
      FROM equipamentos e JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      WHERE TRIM(e.id) = ${id.trim()} LIMIT 1`;
    return r[0]?.planta_id ?? null;
  }

  // ===== Carregadores (equipamentos do tipo carregador) =====
  async listarCarregadores(user?: ScopedUser): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, TRIM(e.unidade_id) AS unidade_id,
             TRIM(u.planta_id) AS planta_id, TRIM(u.nome) AS unidade_nome,
             c.fonte_kwh, c.tarifa_kwh, c.potencia_kw, c.ultimo_estado, c.ultima_leitura_kwh, c.ultima_leitura
      FROM equipamentos e
      JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      LEFT JOIN carregador_config c ON TRIM(c.equipamento_id) = TRIM(e.id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id) = TRIM(e.tipo_equipamento_id)
      WHERE e.deleted_at IS NULL
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%' OR te.nome ILIKE '%carregador%')
      ORDER BY e.nome`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  // ===== Moradores =====
  async listarMoradores(user?: ScopedUser, plantaId?: string): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, nome, apartamento, tag_uid, planta_id, unidade_id, ativo,
             to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
      FROM moradores
      WHERE deleted_at IS NULL AND (${plantaId ?? null}::text IS NULL OR planta_id = ${plantaId ?? null})
      ORDER BY ativo DESC, nome`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async salvarMorador(body: any, user?: ScopedUser): Promise<any> {
    const nome = String(body.nome || '').trim();
    if (!nome) throw new BadRequestException('Nome do morador obrigatório');
    const plantaId = body.planta_id ? String(body.planta_id).trim() : null;
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const tag = body.tag_uid ? String(body.tag_uid).trim().toUpperCase() : null;
    const id = body.id ? String(body.id).trim() : this.genId();
    const existe = body.id
      ? (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM moradores WHERE id=${id} AND deleted_at IS NULL LIMIT 1`).length > 0
      : false;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE moradores SET nome=${nome}, apartamento=${body.apartamento ?? null}, tag_uid=${tag},
          planta_id=${plantaId}, unidade_id=${body.unidade_id ?? null}, ativo=${body.ativo !== false}, updated_at=now()
        WHERE id=${id}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO moradores (id, nome, apartamento, tag_uid, planta_id, unidade_id, ativo)
        VALUES (${id}, ${nome}, ${body.apartamento ?? null}, ${tag}, ${plantaId}, ${body.unidade_id ?? null}, ${body.ativo !== false})`;
    }
    // Re-sincroniza a whitelist de tags dos carregadores da planta.
    if (plantaId) await this.publicarWhitelistPlanta(plantaId);
    return { id };
  }

  async removerMorador(id: string, user?: ScopedUser): Promise<{ ok: boolean }> {
    const r = await this.prisma.$queryRaw<any[]>`SELECT planta_id FROM moradores WHERE id=${id.trim()} LIMIT 1`;
    if (!r.length) return { ok: true };
    await this.assertPlantaNoEscopo(user, r[0].planta_id || '');
    await this.prisma.$executeRaw`UPDATE moradores SET deleted_at=now(), ativo=false WHERE id=${id.trim()}`;
    if (r[0].planta_id) await this.publicarWhitelistPlanta(String(r[0].planta_id).trim());
    return { ok: true };
  }

  // ===== Whitelist de tags → TON (modo automático) =====
  private async publicarWhitelistPlanta(plantaId: string): Promise<void> {
    const cars = await this.prisma.$queryRaw<Array<{ topico: string }>>`
      SELECT TRIM(e.topico_mqtt) AS topico
      FROM equipamentos e JOIN unidades u ON TRIM(u.id)=TRIM(e.unidade_id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id)=TRIM(e.tipo_equipamento_id)
      WHERE u.planta_id=${plantaId} AND e.mqtt_habilitado=true AND COALESCE(e.topico_mqtt,'')<>''
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%')`;
    if (!cars.length) return;
    const tags = (await this.prisma.$queryRaw<Array<{ tag_uid: string }>>`
      SELECT DISTINCT tag_uid FROM moradores WHERE ativo=true AND deleted_at IS NULL AND planta_id=${plantaId} AND COALESCE(tag_uid,'')<>''`
    ).map((r) => r.tag_uid);
    for (const c of cars) {
      const base = c.topico?.replace(/\/+$/, '');
      if (!base) continue;
      try { await this.mqtt.publish(`${base}/cmd/tag_sync`, JSON.stringify({ uids: tags }), { retain: true } as any); }
      catch (e) { this.logger.warn(`[carregador] whitelist não enviada: ${e instanceof Error ? e.message : e}`); }
    }
  }

  // ===== Sessão: liberar (porteiro) =====
  async liberarRecarga(equipamentoId: string, moradorId: string, user?: ScopedUser): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const mor = (await this.prisma.$queryRaw<any[]>`SELECT id, nome FROM moradores WHERE id=${moradorId.trim()} AND deleted_at IS NULL LIMIT 1`)[0];
    if (!mor) throw new NotFoundException('Morador não encontrado');

    // Já existe sessão ativa? não abre outra.
    const ativa = (await this.prisma.$queryRaw<any[]>`SELECT id FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' LIMIT 1`)[0];
    if (ativa) throw new BadRequestException('Já existe uma sessão ativa nesta vaga. Encerre a atual (desconecte o carro) antes.');

    const cfg = (await this.prisma.$queryRaw<any[]>`SELECT ultima_leitura_kwh FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0];
    const kwhInicio = cfg?.ultima_leitura_kwh ?? null;
    const id = this.genId();
    const quem = String((user as any)?.name || (user as any)?.email || 'porteiro');
    await this.prisma.$executeRaw`
      INSERT INTO carregador_sessoes (id, equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, liberado_por, liberado_por_user, status)
      VALUES (${id}, ${eid}, ${plantaId}, ${mor.id}, ${mor.nome}, now(), ${kwhInicio}, 'porteiro', ${quem}, 'ativa')`;
    await this.enviarComando(eid, { carregador: 'habilitar', sessao: id, morador: mor.nome });
    return { id, morador: mor.nome };
  }

  // ===== Pedir a vaga (marca início do ocioso da sessão que ocupa) =====
  async pedirVaga(equipamentoId: string, moradorId: string, user?: ScopedUser): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const mor = (await this.prisma.$queryRaw<any[]>`SELECT id, nome FROM moradores WHERE id=${moradorId.trim()} AND deleted_at IS NULL LIMIT 1`)[0];
    if (!mor) throw new NotFoundException('Morador (solicitante) não encontrado');
    const ativa = (await this.prisma.$queryRaw<any[]>`SELECT id, ocioso_inicio FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' LIMIT 1`)[0];
    // Registra o pedido sempre (log).
    await this.prisma.$executeRaw`
      INSERT INTO carregador_pedidos_vaga (id, equipamento_id, sessao_id, morador_id, morador_nome)
      VALUES (${this.genId()}, ${eid}, ${ativa?.id ?? null}, ${mor.id}, ${mor.nome})`;
    // Só marca o início do ocioso se há sessão ocupando E ainda não foi marcado.
    if (ativa && !ativa.ocioso_inicio) {
      await this.prisma.$executeRaw`
        UPDATE carregador_sessoes SET ocioso_inicio=now(), ocioso_por_morador_id=${mor.id}, ocioso_por_nome=${mor.nome}, updated_at=now()
        WHERE id=${ativa.id}`;
    }
    return { ok: true, ocioso_iniciado: !!(ativa && !ativa.ocioso_inicio) };
  }

  // ===== Encerrar sessão (chamado pela ingestão MQTT ao desconectar) =====
  async encerrarSessao(equipamentoId: string, kwhFinal?: number | null, motivo = 'desconectado'): Promise<any> {
    const eid = equipamentoId.trim();
    const ativa = (await this.prisma.$queryRaw<any[]>`
      SELECT id, kwh_inicio, ocioso_inicio FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' ORDER BY inicio DESC LIMIT 1`)[0];
    if (!ativa) return { ok: false, motivo: 'sem sessão ativa' };
    const kwhFim = (kwhFinal ?? null);
    // kwh_total = fim − inicio (se ambos existem). ocioso_min = fim(agora) − ocioso_inicio.
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET fim=now(), kwh_fim=${kwhFim},
          kwh_total = CASE WHEN ${kwhFim}::numeric IS NOT NULL AND kwh_inicio IS NOT NULL THEN GREATEST(${kwhFim}::numeric - kwh_inicio, 0) ELSE kwh_total END,
          ocioso_min = CASE WHEN ocioso_inicio IS NOT NULL THEN GREATEST(EXTRACT(EPOCH FROM (now() - ocioso_inicio))/60, 0)::int ELSE 0 END,
          status='encerrada', updated_at=now()
      WHERE id=${ativa.id}`;
    // Corta o fornecimento (garantia — a TON já cortou no hardware).
    await this.enviarComando(eid, { carregador: 'desabilitar', motivo });
    return { ok: true, sessao: ativa.id };
  }

  // ===== Ingestão de energia (kWh acumulado) — chamado pelo MqttService =====
  async ingerirEnergia(equipamentoId: string, kwhAcumulado: number, estado?: string): Promise<void> {
    const eid = equipamentoId.trim();
    const existe = (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`).length > 0;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE carregador_config SET ultima_leitura_kwh=${kwhAcumulado}, ultimo_estado=${estado ?? null}, ultima_leitura=now(), updated_at=now()
        WHERE TRIM(equipamento_id)=${eid}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO carregador_config (id, equipamento_id, ultima_leitura_kwh, ultimo_estado, ultima_leitura)
        VALUES (${this.genId()}, ${eid}, ${kwhAcumulado}, ${estado ?? null}, now())`;
    }
    // Atualiza o kWh corrente da sessão ativa (fim provisório).
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET kwh_fim=${kwhAcumulado},
          kwh_total = CASE WHEN kwh_inicio IS NOT NULL THEN GREATEST(${kwhAcumulado}::numeric - kwh_inicio, 0) ELSE kwh_total END,
          updated_at=now()
      WHERE TRIM(equipamento_id)=${eid} AND status='ativa'`;
  }

  // ===== Sessões (lista: ativas + histórico) =====
  async listarSessoes(user?: ScopedUser, equipamentoId?: string, limite = 100): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT s.id, TRIM(s.equipamento_id) AS equipamento_id, s.morador_nome, s.status,
             s.kwh_total, s.ocioso_min, s.liberado_por, s.liberado_por_user, s.ocioso_por_nome, s.planta_id,
             to_char(s.inicio,'DD/MM HH24:MI') AS inicio, to_char(s.fim,'DD/MM HH24:MI') AS fim
      FROM carregador_sessoes s
      WHERE (${equipamentoId ?? null}::text IS NULL OR TRIM(s.equipamento_id) = ${equipamentoId ?? null})
      ORDER BY (s.status='ativa') DESC, s.inicio DESC
      LIMIT ${Math.min(Number(limite) || 100, 500)}`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async getEstado(equipamentoId: string, user?: ScopedUser): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const cfg = (await this.prisma.$queryRaw<any[]>`SELECT * FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0] ?? null;
    const ativa = (await this.prisma.$queryRaw<any[]>`
      SELECT id, morador_nome, kwh_total, to_char(inicio,'DD/MM HH24:MI') AS inicio, ocioso_inicio, ocioso_por_nome
      FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' LIMIT 1`)[0] ?? null;
    const ultimas = await this.listarSessoes(undefined, eid, 8);
    return {
      estado: cfg?.ultimo_estado ?? 'desconhecido',
      fonte_kwh: cfg?.fonte_kwh ?? 'ton',
      tarifa_kwh: cfg?.tarifa_kwh ?? null,
      ultima_leitura_kwh: cfg?.ultima_leitura_kwh ?? null,
      ultima_leitura: cfg?.ultima_leitura ?? null,
      sessao_ativa: ativa,
      sessoes: ultimas,
    };
  }

  // ===== Export mensal (morador · kWh · ocioso · R$) =====
  async exportarMensal(mesAno: string, user?: ScopedUser, plantaId?: string): Promise<{ csv: string; linhas: any[] }> {
    // mesAno: 'YYYY-MM'. Agrega sessões encerradas do mês por morador.
    const m = /^\d{4}-\d{2}$/.test(mesAno) ? mesAno : null;
    if (!m) throw new BadRequestException("Mês inválido (use 'YYYY-MM')");
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const plantas = await this.plantasDoUsuario(user);
    const inicioMes = `${m}-01`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT s.morador_nome AS morador,
             ROUND(COALESCE(SUM(s.kwh_total),0)::numeric, 3) AS kwh,
             COALESCE(SUM(s.ocioso_min),0)::int AS ocioso_min,
             ROUND(COALESCE(SUM(s.kwh_total * COALESCE(c.tarifa_kwh,0)),0)::numeric, 2) AS valor_reais,
             s.planta_id
      FROM carregador_sessoes s
      LEFT JOIN carregador_config c ON TRIM(c.equipamento_id)=TRIM(s.equipamento_id)
      WHERE s.status='encerrada'
        AND s.fim >= ${inicioMes}::date
        AND s.fim < (${inicioMes}::date + interval '1 month')
        AND (${plantaId ?? null}::text IS NULL OR s.planta_id = ${plantaId ?? null})
      GROUP BY s.morador_nome, s.planta_id
      ORDER BY s.morador_nome`;
    const linhas = plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
    const header = 'Morador;kWh;Ocioso (min);Valor (R$)';
    const body = linhas.map((r) => `${(r.morador ?? '—')};${r.kwh};${r.ocioso_min};${String(r.valor_reais).replace('.', ',')}`).join('\n');
    return { csv: `${header}\n${body}\n`, linhas };
  }

  // ===== Comando MQTT ao carregador (habilitar/desabilitar) =====
  private async enviarComando(equipamentoId: string, payload: Record<string, unknown>): Promise<void> {
    const eq = (await this.prisma.$queryRaw<Array<{ topico: string }>>`
      SELECT TRIM(topico_mqtt) AS topico FROM equipamentos WHERE TRIM(id)=${equipamentoId.trim()} AND mqtt_habilitado=true LIMIT 1`)[0];
    const base = eq?.topico?.replace(/\/+$/, '');
    if (!base) { this.logger.warn(`[carregador] ${equipamentoId} sem topico_mqtt — comando não enviado`); return; }
    try { await this.mqtt.publish(`${base}/cmd`, JSON.stringify(payload)); }
    catch (e) { this.logger.error(`[carregador] falha no comando: ${e instanceof Error ? e.message : e}`); }
  }

  /** Resolve o equipamento (carregador) por tópico base — usado pela ingestão MQTT. */
  async carregadorPorTopico(base: string): Promise<string | null> {
    const b = base.replace(/\/+$/, '');
    const r = (await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(id) AS id FROM equipamentos WHERE TRIM(topico_mqtt)=${b} AND deleted_at IS NULL LIMIT 1`)[0];
    return r?.id ?? null;
  }
}
