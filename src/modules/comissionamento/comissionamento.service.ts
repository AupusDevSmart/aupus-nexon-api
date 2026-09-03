import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { randomBytes } from 'crypto';
import { promises as fsp } from 'fs';
import { join, basename } from 'path';
import { rodarChecks, ChecksResult, LeituraComissionamento, TonDiag } from './comissionamento.checks';
import { extrairGrandezas } from './comissionamento.grandezas';

/**
 * Comissionamento (Fase 0) — verifica COERÊNCIA de dado de um ponto na instalação e
 * registra o aceite. Owner-scoped (equipamento dentro do escopo do usuário). NÃO gera
 * gate ainda (não esconde do COA nem muda alerta) — preview + registro. Gate = fase
 * futura. Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.
 */
@Injectable()
export class ComissionamentoService {
  private readonly logger = new Logger(ComissionamentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private novoId(): string {
    return randomBytes(13).toString('hex'); // 26 chars, padrão do projeto
  }

  /** Últimas N leituras de um equipamento (mais recente primeiro). */
  private async leiturasRecentes(equipamentoId: string, limite = 20): Promise<LeituraComissionamento[]> {
    const rows = await this.prisma.$queryRaw<Array<LeituraComissionamento>>`
      SELECT dados, timestamp_dados, qualidade
      FROM equipamentos_dados
      WHERE TRIM(equipamento_id) = ${equipamentoId.trim()}
      ORDER BY timestamp_dados DESC
      LIMIT ${limite}
    `;
    return rows || [];
  }

  /** Diagnóstico (<base>/diagnostics) da TON que serve este equipamento — match por prefixo. */
  private async tonDiagDoEquip(equipTopico: string | null | undefined): Promise<TonDiag | null> {
    const t = equipTopico?.trim();
    if (!t) return null;
    try {
      const rows = await this.prisma.$queryRaw<Array<TonDiag>>`
        SELECT online, wifi_rssi, modbus_ok, modbus_err
        FROM iot_dispositivos_online d
        WHERE ${t} = TRIM(d.topico_mqtt) OR starts_with(${t}, TRIM(d.topico_mqtt) || '/')
        ORDER BY d.last_seen DESC NULLS LAST
        LIMIT 1
      `;
      return rows?.[0] ?? null;
    } catch {
      return null; // diagnóstico é best-effort — não bloqueia o comissionamento
    }
  }

  private async equipOuFalha(equipamentoId: string) {
    const eq = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId.trim(), deleted_at: null },
      select: { id: true, nome: true, tipo_equipamento: true, topico_mqtt: true, unidade_id: true, planta_id: true },
    });
    if (!eq) throw new NotFoundException('Equipamento não encontrado.');
    return eq;
  }

  /** Roda os checks ao vivo (preview) — não persiste. */
  async avaliar(equipamentoId: string, user: ScopedUser | undefined): Promise<ChecksResult & { grandezas: any[]; equipamento: any }> {
    await this.scope.assertEntityInScope('equipamento', equipamentoId, user);
    const eq = await this.equipOuFalha(equipamentoId);
    const leituras = await this.leiturasRecentes(equipamentoId);
    const tonDiag = await this.tonDiagDoEquip(eq.topico_mqtt);
    const resultado = rodarChecks(leituras, { nome: eq.nome, tipo: eq.tipo_equipamento, tonDiag });
    // Principais grandezas do JSON (o que o instalador confere contra o equipamento real).
    const grandezas = extrairGrandezas(leituras[0]?.dados ?? null, eq.tipo_equipamento);
    return { ...resultado, grandezas, equipamento: { id: eq.id, nome: eq.nome, tipo: eq.tipo_equipamento } };
  }

  /** Registro armazenado + preview atual. */
  async status(equipamentoId: string, user: ScopedUser | undefined) {
    const preview = await this.avaliar(equipamentoId, user);
    const armazenado = await this.prisma.$queryRaw<Array<any>>`
      SELECT status, resultado, observacoes, comissionado_por, comissionado_por_nome, comissionado_em, fotos
      FROM iot_comissionamento WHERE TRIM(equipamento_id) = ${equipamentoId.trim()} LIMIT 1
    `;
    return { armazenado: armazenado?.[0] ?? null, preview };
  }

  /** Registra o aceite (sign-off). Bloqueia em 'falha' sem `forcar`. Admin no controller. */
  async comissionar(
    equipamentoId: string,
    user: (ScopedUser & { name?: string }) | undefined,
    body: {
      observacoes?: string;
      forcar?: boolean;
      // Conferência humana: por grandeza, o valor real (no equipamento) e se confere.
      confirmacoes?: Array<{ campo: string; label?: string; nexon?: number | string | null; real?: number | string | null; confere?: boolean }>;
    } = {},
  ) {
    await this.scope.assertEntityInScope('equipamento', equipamentoId, user);
    const eq = await this.equipOuFalha(equipamentoId);
    const leituras = await this.leiturasRecentes(equipamentoId);
    const tonDiag = await this.tonDiagDoEquip(eq.topico_mqtt);
    const resultado = rodarChecks(leituras, { nome: eq.nome, tipo: eq.tipo_equipamento, tonDiag });
    const grandezas = extrairGrandezas(leituras[0]?.dados ?? null, eq.tipo_equipamento);

    if (resultado.resumo === 'falha' && !body.forcar) {
      const falhas = resultado.itens.filter((i) => i.status === 'falha').map((i) => i.titulo);
      throw new ForbiddenException(
        `Comissionamento reprovado: ${falhas.join(', ')}. Corrija ou use "forçar" com justificativa.`,
      );
    }

    const status = resultado.resumo === 'falha' ? 'comissionado_com_ressalva' : 'comissionado';
    // Guarda checks + grandezas + a conferência humana (o núcleo do comissionamento).
    const resultadoStore = { ...resultado, grandezas, confirmacoes: body.confirmacoes ?? [] };
    const snapshot = leituras[0]?.dados ?? null;
    const id = this.novoId();
    const uid = (user?.id || '').trim() || null;
    const uname = (user?.name || '').slice(0, 120) || null;

    await this.prisma.$executeRaw`
      INSERT INTO iot_comissionamento
        (id, equipamento_id, status, resultado, snapshot, observacoes, comissionado_por, comissionado_por_nome, comissionado_em, created_at, updated_at)
      VALUES
        (${id}, ${equipamentoId.trim()}, ${status}, ${JSON.stringify(resultadoStore)}::jsonb, ${JSON.stringify(snapshot)}::jsonb,
         ${body.observacoes ?? null}, ${uid}, ${uname}, now(), now(), now())
      ON CONFLICT (equipamento_id) DO UPDATE SET
        status = EXCLUDED.status,
        resultado = EXCLUDED.resultado,
        snapshot = EXCLUDED.snapshot,
        observacoes = EXCLUDED.observacoes,
        comissionado_por = EXCLUDED.comissionado_por,
        comissionado_por_nome = EXCLUDED.comissionado_por_nome,
        comissionado_em = now(),
        updated_at = now()
    `;
    this.logger.log(`[Comissionamento] ${eq.nome} (${equipamentoId}) → ${status} por ${uname || uid || '?'}`);
    return { status, resultado };
  }

  private readonly FOTO_DIR = 'comissionamento';
  private readonly FOTO_MAX_BYTES = 6 * 1024 * 1024; // 6MB/foto (cliente já faz downscale)

  /** Adiciona uma foto de PROVA (data URL base64) ao comissionamento do ponto. Admin. */
  async adicionarFoto(
    equipamentoId: string,
    user: (ScopedUser & { name?: string }) | undefined,
    body: { dataUrl?: string; nome?: string } = {},
  ) {
    await this.scope.assertEntityInScope('equipamento', equipamentoId, user);
    const eq = await this.equipOuFalha(equipamentoId);
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(body.dataUrl || ''));
    if (!m) throw new BadRequestException('Foto inválida (esperado data URL de imagem jpeg/png/webp).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > this.FOTO_MAX_BYTES) {
      throw new BadRequestException(`Foto vazia ou grande demais (máx ${Math.round(this.FOTO_MAX_BYTES / 1048576)}MB).`);
    }
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const dir = join(process.cwd(), 'uploads', this.FOTO_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${equipamentoId.trim()}_${randomBytes(8).toString('hex')}.${ext}`;
    await fsp.writeFile(join(dir, filename), buf);

    const foto = {
      url: `/api/v1/uploads/${this.FOTO_DIR}/${filename}`,
      nome: (body.nome || '').slice(0, 120) || null,
      por: (user?.name || '').slice(0, 120) || null,
      em: new Date().toISOString(),
    };
    const id = this.novoId();
    await this.prisma.$executeRaw`
      INSERT INTO iot_comissionamento (id, equipamento_id, status, fotos, created_at, updated_at)
      VALUES (${id}, ${equipamentoId.trim()}, 'pendente', ${JSON.stringify([foto])}::jsonb, now(), now())
      ON CONFLICT (equipamento_id) DO UPDATE SET
        fotos = COALESCE(iot_comissionamento.fotos, '[]'::jsonb) || ${JSON.stringify([foto])}::jsonb,
        updated_at = now()
    `;
    this.logger.log(`[Comissionamento] foto add em ${eq.nome} (${equipamentoId}) por ${foto.por || '?'}`);
    return foto;
  }

  /** Remove uma foto de prova (pela url). Admin. */
  async removerFoto(equipamentoId: string, user: ScopedUser | undefined, url: string) {
    await this.scope.assertEntityInScope('equipamento', equipamentoId, user);
    const rows = await this.prisma.$queryRaw<Array<{ fotos: any }>>`
      SELECT fotos FROM iot_comissionamento WHERE TRIM(equipamento_id) = ${equipamentoId.trim()} LIMIT 1
    `;
    const atuais: Array<{ url: string }> = Array.isArray(rows?.[0]?.fotos) ? rows[0].fotos : [];
    const restantes = atuais.filter((f) => f?.url !== url);
    await this.prisma.$executeRaw`
      UPDATE iot_comissionamento SET fotos = ${JSON.stringify(restantes)}::jsonb, updated_at = now()
      WHERE TRIM(equipamento_id) = ${equipamentoId.trim()}
    `;
    // Apaga o arquivo — basename() barra path traversal; só dentro do dir esperado.
    try {
      const fname = basename(String(url || ''));
      if (fname && String(url).includes(`/uploads/${this.FOTO_DIR}/`)) {
        await fsp.unlink(join(process.cwd(), 'uploads', this.FOTO_DIR, fname));
      }
    } catch { /* arquivo pode já não existir */ }
    return { removidas: atuais.length - restantes.length, restantes: restantes.length };
  }

  /** Lista pontos (mqtt_habilitado) com o status de comissionamento — owner-scoped. */
  async listar(user: ScopedUser | undefined, plantaId?: string, unidadeId?: string) {
    const escopo = await this.scope.getScope(user);
    const scoped = this.scope.isScoped(escopo);
    if (plantaId) await this.scope.assertPlantaInScope(plantaId, user);

    // Dataset pequeno (equipamentos mqtt_habilitado ~dezenas) → filtra escopo/planta em JS
    // (evita passar array como parâmetro do Prisma em `= ANY(...)`).
    const rows = await this.prisma.$queryRaw<Array<any>>`
      -- planta vem da UNIDADE (equipamentos.planta_id costuma ser NULL quando o
      -- equipamento é associado só via unidade) → LEFT JOIN por u.planta_id.
      SELECT TRIM(e.id) AS equipamento_id, e.nome AS equipamento, e.tipo_equipamento AS tipo,
             TRIM(u.nome) AS unidade, TRIM(e.unidade_id) AS unidade_id,
             TRIM(p.nome) AS planta, TRIM(u.planta_id) AS planta_id,
             COALESCE(c.status, 'pendente') AS status,
             c.comissionado_em, c.comissionado_por_nome,
             (c.resultado->>'resumo') AS ultimo_resumo
      FROM equipamentos e
      JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      LEFT JOIN plantas p ON TRIM(p.id) = TRIM(u.planta_id)
      LEFT JOIN iot_comissionamento c ON TRIM(c.equipamento_id) = TRIM(e.id)
      WHERE e.mqtt_habilitado = true AND e.deleted_at IS NULL
        -- Só pontos com FEED REAL (reportou nos últimos 7 dias) OU já comissionados —
        -- mesmo critério do COA (expectedPorUnidade). Exclui fantasmas: equipamento
        -- mqtt_habilitado que sobrou de exclusão pelo unifilar e nunca/não reporta mais.
        AND (
          EXISTS (
            SELECT 1 FROM equipamentos_dados ed
            WHERE TRIM(ed.equipamento_id) = TRIM(e.id)
              AND ed.timestamp_dados > now() - interval '7 days'
          )
          OR c.equipamento_id IS NOT NULL
        )
      ORDER BY p.nome, u.nome, e.nome
    `;
    let out = rows || [];
    if (scoped) {
      const permitidas = new Set((escopo as string[]).map((x) => String(x).trim()));
      out = out.filter((r) => permitidas.has(String(r.planta_id).trim()));
    }
    if (plantaId) out = out.filter((r) => String(r.planta_id).trim() === plantaId.trim());
    if (unidadeId) out = out.filter((r) => String(r.unidade_id).trim() === unidadeId.trim());
    return out;
  }

  /**
   * Equipamentos FANTASMA da unidade: mqtt_habilitado, mas FORA de qualquer diagrama
   * (diagrama_id NULL) e SEM feed há 7 dias — sobra de exclusão/migração que o unifilar
   * não consegue deletar (não aparece lá). Exclui TON (IoT-only, legítimo fora do unifilar).
   * A exclusão em si reusa DELETE /equipamentos/:id (soft-delete + desinscrição MQTT).
   */
  async listarOrfaos(user: ScopedUser | undefined, unidadeId?: string) {
    const escopo = await this.scope.getScope(user);
    const scoped = this.scope.isScoped(escopo);
    if (unidadeId) await this.scope.assertEntityInScope('unidade', unidadeId, user);

    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT TRIM(e.id) AS equipamento_id, e.nome AS equipamento, e.tipo_equipamento AS tipo,
             COALESCE(NULLIF(TRIM(e.topico_mqtt), ''), '(sem tópico)') AS topico,
             to_char(e.created_at, 'YYYY-MM-DD') AS criado,
             TRIM(e.unidade_id) AS unidade_id, TRIM(u.planta_id) AS planta_id
      FROM equipamentos e
      JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      WHERE e.mqtt_habilitado = true AND e.deleted_at IS NULL
        AND e.diagrama_id IS NULL
        AND (e.tipo_equipamento IS NULL OR e.tipo_equipamento NOT ILIKE 'TON%')
        AND NOT EXISTS (
          SELECT 1 FROM equipamentos_dados ed
          WHERE TRIM(ed.equipamento_id) = TRIM(e.id)
            AND ed.timestamp_dados > now() - interval '7 days'
        )
      ORDER BY u.nome, e.nome
    `;
    let out = rows || [];
    if (scoped) {
      const perm = new Set((escopo as string[]).map((x) => String(x).trim()));
      out = out.filter((r) => perm.has(String(r.planta_id).trim()));
    }
    if (unidadeId) out = out.filter((r) => String(r.unidade_id).trim() === unidadeId.trim());
    return out;
  }
}
