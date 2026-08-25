import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { Prisma } from '@aupus/api-shared';
import { tonCapsForTipo } from '../../shared/util/ton-caps';
import type {
  IotDiagrama,
  IotDiagramaComponent,
  IotDiagramaConnection,
  IotProjetoRow,
} from './interfaces/iot-diagrama.interface';

const EMPTY_DIAGRAMA: IotDiagrama = {
  components: [],
  connections: [],
  nextId: 1,
};

const PROJETO_SELECT = {
  id: true,
  unidade_id: true,
  nome: true,
  diagrama: true,
  created_at: true,
  updated_at: true,
} as const;

/**
 * Service de projetos IoT.
 *
 * Persistencia dupla durante transicao (PR1, 2026-05):
 * - Cache JSONB em `iot_projetos.diagrama` — formato consumido pelo frontend
 *   legado iot-diagram.v2.js sem mudancas. Continua sendo a fonte do GET.
 * - Tabelas relacionais `iot_componentes` + `iot_conexoes` — base da
 *   integracao IoT <-> Diagrama Unifilar via FK iot_componentes.equipamento_id.
 *
 * Em PUT, ambos sao escritos juntos numa transacao. JSONB sera deprecated
 * apos 1-2 sprints estaveis.
 *
 * Sobre o sync delete-all+insert-all em syncRelational: simples e atomico
 * mas faz CASCADE em iot_firmwares e SET NULL em iot_dispositivos_online dos
 * componentes. Aceitavel hoje (ambas tabelas sem dados de producao). Quando
 * ganharem, trocar por delta upsert preservando IDs estaveis.
 */
@Injectable()
export class IoTService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  /** Gera um ID hex de 26 chars compativel com CHAR(26) — preserva o formato dos registros existentes. */
  private generateId(): string {
    return randomBytes(13).toString('hex');
  }

  /** Resolve unidade_id de um projeto IoT. */
  private async unidadeIdDoProjeto(projetoId: string): Promise<string | null> {
    const p = await this.prisma.iot_projetos.findFirst({
      where: { id: projetoId.trim() },
      select: { unidade_id: true },
    });
    return p?.unidade_id?.trim() ?? null;
  }

  async getProjetosByUnidade(unidadeId: string, user?: ScopedUser): Promise<IotProjetoRow[]> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const rows = await this.prisma.iot_projetos.findMany({
      where: { unidade_id: unidadeId.trim(), deleted_at: null },
      orderBy: { created_at: 'asc' },
      select: PROJETO_SELECT,
    });
    return rows.map(this.toProjetoRow);
  }

  async getProjetoById(id: string, user?: ScopedUser): Promise<IotProjetoRow | null> {
    const row = await this.prisma.iot_projetos.findFirst({
      where: { id: id.trim(), deleted_at: null },
      select: PROJETO_SELECT,
    });
    if (!row) return null;
    if (user) await this.scopeService.assertEntityInScope('unidade', row.unidade_id.trim(), user);
    return this.toProjetoRow(row);
  }

  /**
   * Resolve o Power Meter (só-IoT) associado a um DISJUNTOR do unifilar. O link fica em
   * `iot_componentes.props.disjuntor_equipamento_id` (gravado pelo modal de props do PM).
   * Retorna o `equipamento_id` + nome do PM pra o unifilar abrir o PowerMeterModal ao
   * clicar no disjuntor associado. null se o disjuntor não tem PM associado.
   */
  async powerMeterByDisjuntor(
    disjuntorEquipId: string,
  ): Promise<{ equipamento_id: string; nome: string | null } | null> {
    const id = (disjuntorEquipId ?? '').trim();
    if (!id) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{ equipamento_id: string; nome: string | null }>
    >`
      SELECT c.props->>'equipamento_id' AS equipamento_id,
             c.props->>'name'           AS nome
      FROM iot_componentes c
      WHERE c.props->>'disjuntor_equipamento_id' = ${id}
        AND COALESCE(c.props->>'equipamento_id', '') <> ''
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Fonte do status ABERTO/FECHADO de um disjuntor do unifilar.
   *
   * Quem lê os contatos auxiliares (52a/52b) do DJ é o RELÉ: ele publica os
   * sinais do catálogo (`dj_aberto`/`dj_fechado`) na SUA propria telemetria. O
   * vínculo relé→disjuntor vive no `io_config.bi` do componente do relé
   * (`{ <sinal>: { equipamento_id: <disjuntor>, ponto_id } }`), que hoje só
   * existe como JSON. Este lookup inverte esse mapa: dado o disjuntor, diz de
   * QUEM o front deve assinar a telemetria ao vivo e QUAIS campos ler.
   *
   * ⚠️ RBAC: o disjuntor pertence a uma unidade — escopado por dono.
   */
  async statusFonteDoDisjuntor(
    disjuntorEquipId: string,
    user?: ScopedUser,
  ): Promise<{
    rele_equipamento_id: string;
    rele_nome: string | null;
    campo_aberto: string | null;
    campo_fechado: string | null;
  } | null> {
    const id = (disjuntorEquipId ?? '').trim();
    if (!id) return null;

    if (user) {
      const u = await this.prisma.$queryRaw<Array<{ unidade_id: string | null }>>`
        SELECT TRIM(unidade_id) AS unidade_id FROM equipamentos WHERE TRIM(id) = ${id} LIMIT 1
      `;
      const unidadeId = u[0]?.unidade_id?.trim();
      if (unidadeId) {
        await this.scopeService.assertEntityInScope('unidade', unidadeId, user);
      }
    }

    // ids sao char(26): TRIM dos dois lados (o io_config antigo gravava com padding).
    const rows = await this.prisma.$queryRaw<
      Array<{ rele_equipamento_id: string; rele_nome: string | null; campo: string }>
    >`
      SELECT COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id') AS rele_equipamento_id,
             c.props->>'name' AS rele_nome,
             kv.key           AS campo
      FROM iot_componentes c,
           jsonb_each(COALESCE(c.props->'io_config'->'bi', '{}'::jsonb)) AS kv
      WHERE TRIM(COALESCE(kv.value->>'equipamento_id', '')) = ${id}
        AND COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id', '') <> ''
    `;
    if (rows.length === 0) return null;

    const campos = rows.map((r) => r.campo);
    return {
      rele_equipamento_id: rows[0].rele_equipamento_id,
      rele_nome: rows[0].rele_nome,
      campo_aberto: campos.find((c) => /aberto/i.test(c)) ?? null,
      campo_fechado: campos.find((c) => /fechado/i.test(c)) ?? null,
    };
  }

  async createProjeto(unidadeId: string, nome: string, user?: ScopedUser): Promise<IotProjetoRow> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const created = await this.prisma.iot_projetos.create({
      data: {
        id: this.generateId(),
        unidade_id: unidadeId.trim(),
        nome,
        diagrama: EMPTY_DIAGRAMA as unknown as Prisma.InputJsonValue,
      },
      select: PROJETO_SELECT,
    });
    return this.toProjetoRow(created);
  }

  async updateProjeto(
    id: string,
    data: { nome?: string; diagrama?: IotDiagrama },
    user?: ScopedUser,
  ): Promise<IotProjetoRow> {
    const trimmedId = id.trim();
    if (user) {
      const unidadeId = await this.unidadeIdDoProjeto(trimmedId);
      if (unidadeId) await this.scopeService.assertEntityInScope('unidade', unidadeId, user);
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
      }

      const updateData: Prisma.iot_projetosUpdateInput = {};
      if (data.nome !== undefined) updateData.nome = data.nome;
      if (data.diagrama !== undefined) {
        // TON e' dominio IoT: auto-cria/vincula o equipamento de cada TON (idempotente)
        // e carimba equipamento_id no JSON ANTES de salvar (unifilar/OTA/syncRelational usam).
        await this.ensureTonEquipamentos(tx, trimmedId, data.diagrama);
        // Devices Modbus (rele/medidor/inversor) tambem viram equipamento sozinhos —
        // depois da TON, pois o topico deles deriva do topico dela.
        await this.ensureDeviceEquipamentos(tx, trimmedId, data.diagrama);
        // Bomba de combustivel: AUTO-CRIA/associa o equipamento (igual TON/devices),
        // liga automacao e cria os pontos canonicos, pra ela aparecer no Configurar
        // BOs/BIs da TON (mecanismo IO padrao).
        await this.ensureBombaEquipamentos(tx, trimmedId, data.diagrama);
        // Carregador eletrico: mesmo padrao — auto-cria/associa + pontos + config.
        await this.ensureCarregadorEquipamentos(tx, trimmedId, data.diagrama);
        updateData.diagrama = data.diagrama as unknown as Prisma.InputJsonValue;
        updateData.view_pan_x = data.diagrama.pan?.x ?? 0;
        updateData.view_pan_y = data.diagrama.pan?.y ?? 0;
        updateData.view_zoom = data.diagrama.zoom ?? 1;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.iot_projetos.update({
          where: { id: trimmedId },
          data: updateData,
        });
      }

      if (data.diagrama !== undefined) {
        await this.syncRelational(tx, trimmedId, data.diagrama);
      }

      const updated = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: PROJETO_SELECT,
      });
      if (!updated) {
        throw new NotFoundException(
          `Projeto IoT ${trimmedId} desapareceu durante o update`,
        );
      }
      return this.toProjetoRow(updated);
    });
  }

  async deleteProjeto(id: string, user?: ScopedUser): Promise<void> {
    const trimmedId = id.trim();
    const existing = await this.prisma.iot_projetos.findFirst({
      where: { id: trimmedId, deleted_at: null },
      select: { id: true, unidade_id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
    }
    if (user) await this.scopeService.assertEntityInScope('unidade', existing.unidade_id.trim(), user);
    await this.prisma.iot_projetos.update({
      where: { id: trimmedId },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * Auto-cria (ou re-vincula) o equipamento de cada TON do diagrama que ainda nao
   * tem equipamento_id valido, e CARIMBA o id em comp.props.equipamento_id (muta o
   * diagrama, salvo logo em seguida). TON e' dominio IoT — o equipamento e' criado
   * aqui automaticamente, nao pela tela de cadastro.
   *
   * Idempotente (roda a cada save): (1) se o comp ja tem equipamento_id valido, pula;
   * (2) senao, se existe um equipamento com o mesmo topico_mqtt, REUSA; (3) senao cria.
   */
  private async ensureTonEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const tons = diagrama.components.filter((c) =>
      String((c as { type?: string }).type ?? '').toLowerCase().startsWith('ton'),
    );
    if (tons.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    const tipoTon = await tx.tipos_equipamentos.findFirst({
      where: { nome: 'TON' },
      select: { id: true },
    });
    const tipoTonId = tipoTon?.id?.trim() || null;

    for (const comp of tons) {
      const props =
        ((comp as { props?: Record<string, unknown> }).props ?? {}) as Record<
          string,
          unknown
        >;
      const topico = String(props.mqtt_topic_base ?? '').trim();

      // (1) ja vinculado e valido? MANTEM o vinculo; so PROPAGA o topico se ele
      // mudou (usuario preencheu o Topico Base DEPOIS de ja ter o equipamento) —
      // e aí liga o MQTT. Sem isso, preencher o topico depois nunca chegava no ativo.
      const rawEquip = this.rawEquipamentoId(comp);
      if (rawEquip) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: rawEquip, deleted_at: null },
          select: { id: true, topico_mqtt: true },
        });
        if (ok) {
          if (topico && (ok.topico_mqtt ?? '').trim() !== topico) {
            await tx.equipamentos.update({
              where: { id: ok.id },
              data: { topico_mqtt: topico, mqtt_habilitado: true },
            });
          }
          continue;
        }
      }

      const tipo = String((comp as { type?: string }).type ?? '').toLowerCase();
      // Capacidade por DADO, nunca igualdade exata de tipo (briefing TON-V2
      // §4.2: 'ton3v2'/'ton4v2' precisam entrar — lista solta quebra em silêncio).
      const automacao = tonCapsForTipo(tipo)?.comando ?? false;

      let equipId: string;
      // (2) reusa equipamento existente com este topico_mqtt (idempotencia forte).
      //     SO quando ha topico — senao `null` casaria com centenas de equipamentos
      //     sem topico e "reusaria" o ativo errado.
      const existente = topico
        ? await tx.equipamentos.findFirst({
            where: { topico_mqtt: topico, deleted_at: null },
            select: { id: true },
          })
        : null;
      if (existente) {
        equipId = existente.id.trim();
      } else {
        // (3) cria — MESMO SEM topico. A TON e' criada+associada ja no save, igual
        //     aos outros ativos (inversor/medidor via /rapido tambem nascem sem
        //     topico). O Topico Base pode ser preenchido depois: o passo (1) acima
        //     propaga pro ativo no proximo save. Comando/OTA/telemetria so
        //     funcionam com topico (por isso mqtt_habilitado segue o topico), mas a
        //     TON ja aparece ASSOCIADA no dropdown — que era a dor do usuario.
        //     topico_mqtt e' nullable e tem so INDEX (nao unique) — null e' seguro.
        const nome =
          String(props.name ?? props.ota_hostname ?? tipo.toUpperCase()).trim() || 'TON';
        const novo = await tx.equipamentos.create({
          data: {
            id: this.generateId(),
            nome,
            classificacao: 'UC',
            criticidade: '3',
            tipo_equipamento: tipo.toUpperCase(),
            mqtt_habilitado: !!topico,
            automacao,
            topico_mqtt: topico || null,
            ...(unidadeId ? { unidade_id: unidadeId } : {}),
            ...(tipoTonId ? { tipo_equipamento_id: tipoTonId } : {}),
          },
          select: { id: true },
        });
        equipId = novo.id.trim();
      }

      // carimba no JSON (o updateProjeto salva `data.diagrama` logo depois).
      (comp as { props?: Record<string, unknown> }).props = {
        ...props,
        equipamento_id: equipId,
      };
    }
  }

  /**
   * Bomba de combustível: prepara o equipamento da bomba pro mecanismo PADRÃO de
   * IO da TON. A bomba NÃO guarda BO/BI nas props — quem mapeia relé/entrada é a
   * TON (modal da TON → Configurar BOs/BIs → ton_bo/ton_bi), e esses modais só
   * listam equipamentos com `automacao=true` e escolhem entre os PONTOS dele.
   * Então aqui, a cada save (idempotente):
   *   (1) liga `automacao` no equipamento da bomba;
   *   (2) cria os pontos canônicos se faltarem — comando Ligar/Desligar/Solenoide,
   *       status Cartão/Emergência, medição Nível.
   * Os NOMES casam com a resolução por papel do gerador de firmware
   * (`boRole`/`biRole` em iot-diagram.tsx), que lê ton_bo/ton_bi e injeta os
   * números físicos na geração. O nível (AI) não entra aqui: não há `ton_ai`.
   */
  private async ensureBombaEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const comps = diagrama.components as Array<Record<string, any>>;
    const bombas = comps.filter(
      (c) => String(c?.type ?? '').toLowerCase() === 'bomba',
    );
    if (bombas.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    // Tipo do catálogo (codigo BOMBA_COMBUSTIVEL) — mesma abordagem do ensureTon
    // (busca por nome='TON'). Fallback pela string se o rel não existir.
    const tipoBomba = await tx.tipos_equipamentos.findFirst({
      where: { codigo: 'BOMBA_COMBUSTIVEL' },
      select: { id: true },
    });
    const tipoBombaId = tipoBomba?.id?.trim() || null;

    // Ids já usados por QUALQUER componente do diagrama — pra não reusar um ativo
    // que outro nó já reivindicou (nem outra bomba irmã).
    const jaReferenciados = new Set<string>(
      comps
        .map((c) =>
          this.rawEquipamentoId(c as unknown as IotDiagramaComponent) ?? '',
        )
        .filter(Boolean),
    );

    // Pontos vêm do CATÁLOGO (iot_device_tipos.pontos da bomba) — configurável por
    // DADO, sem deploy: bo→comando, bi→status, ai→medicao. Adicionar/mudar um papel
    // = editar o catálogo. Fallback pro conjunto canônico se o catálogo vier vazio.
    // Os NOMES batem com a resolução por papel do gerador (boRole/biRole/aiRole:
    // "Ligar"→liga, "Desligar"→desliga, "Solenoide"→solenoide, "Cartão"→cartao,
    // "Emergência"→estop, "Nível"→nivel).
    type PontoDef = { tipo: string; nome: string; unidade: string | null; ordem: number };
    const FALLBACK_PONTOS: PontoDef[] = [
      { tipo: 'comando', nome: 'Ligar', unidade: null, ordem: 1 },
      { tipo: 'comando', nome: 'Desligar', unidade: null, ordem: 2 },
      { tipo: 'comando', nome: 'Solenoide', unidade: null, ordem: 3 },
      { tipo: 'status', nome: 'Cartão', unidade: null, ordem: 1 },
      { tipo: 'status', nome: 'Emergência', unidade: null, ordem: 2 },
      { tipo: 'medicao', nome: 'Nível', unidade: '%', ordem: 1 },
    ];
    const catalogo = await tx.iot_device_tipos.findFirst({
      where: { codigo: 'bomba_combustivel' },
      select: { pontos: true },
    });
    const catPontos = (catalogo?.pontos ?? null) as {
      bo?: Array<{ id?: string; label?: string; unit?: string }>;
      bi?: Array<{ id?: string; label?: string; unit?: string }>;
      ai?: Array<{ id?: string; label?: string; unit?: string }>;
    } | null;
    const mapCat = (
      arr: Array<{ id?: string; label?: string; unit?: string }> | undefined,
      tipo: string,
      unidadeDefault: string | null,
    ): PontoDef[] =>
      (arr ?? [])
        .map((p, i) => ({
          tipo,
          nome: String(p.label ?? p.id ?? '').trim(),
          unidade: p.unit ?? unidadeDefault,
          ordem: i + 1,
        }))
        .filter((p) => !!p.nome);
    const doCatalogo: PontoDef[] = [
      ...mapCat(catPontos?.bo, 'comando', null),
      ...mapCat(catPontos?.bi, 'status', null),
      ...mapCat(catPontos?.ai, 'medicao', '%'),
    ];
    const PONTOS: PontoDef[] = doCatalogo.length > 0 ? doCatalogo : FALLBACK_PONTOS;

    for (const comp of bombas) {
      const props = (comp.props ?? {}) as Record<string, unknown>;

      // (1) já vinculado e válido? mantém.
      let equipId = this.rawEquipamentoId(
        comp as unknown as IotDiagramaComponent,
      );
      if (equipId) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: equipId, deleted_at: null },
          select: { id: true },
        });
        if (!ok) equipId = null;
      }

      // (2) não vinculado → REUSA uma bomba existente da unidade ainda não
      // reivindicada por outro nó; senão CRIA (igual aos outros ativos: nasce no
      // save, sem tópico — a telemetria da bomba sai pelo tópico da TON).
      if (!equipId) {
        const reusavel =
          unidadeId
            ? await tx.equipamentos.findFirst({
                where: {
                  unidade_id: unidadeId,
                  deleted_at: null,
                  id: { notIn: Array.from(jaReferenciados) },
                  ...(tipoBombaId
                    ? { tipo_equipamento_id: tipoBombaId }
                    : { tipo_equipamento: 'BOMBA_COMBUSTIVEL' }),
                },
                select: { id: true },
                orderBy: { created_at: 'asc' },
              })
            : null;
        if (reusavel) {
          equipId = reusavel.id.trim();
        } else {
          const nome =
            String(props.name ?? 'Bomba de Combustível').trim() ||
            'Bomba de Combustível';
          const novo = await tx.equipamentos.create({
            data: {
              id: this.generateId(),
              nome,
              classificacao: 'UC',
              criticidade: '3',
              tipo_equipamento: 'BOMBA_COMBUSTIVEL',
              mqtt_habilitado: false, // telemetria sai pelo tópico da TON, não daqui
              automacao: true, // obrigatória: Configurar BOs/BIs só lista automação
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              ...(tipoBombaId ? { tipo_equipamento_id: tipoBombaId } : {}),
            },
            select: { id: true },
          });
          equipId = novo.id.trim();
        }
        jaReferenciados.add(equipId);
        // carimba no JSON (salvo logo depois pelo updateProjeto).
        (comp as { props?: Record<string, unknown> }).props = {
          ...props,
          equipamento_id: equipId,
        };
      }

      // (3) garante automação ligada (Configurar BOs/BIs exige) + pontos canônicos.
      const eq = await tx.equipamentos.findFirst({
        where: { id: equipId, deleted_at: null },
        select: { id: true, automacao: true },
      });
      if (!eq) continue;
      if (!eq.automacao) {
        await tx.equipamentos.update({
          where: { id: equipId },
          data: { automacao: true },
        });
      }

      for (const pt of PONTOS) {
        // UNIQUE (equipamento_id, nome) inclui soft-deletados — casa por nome e
        // reativa em vez de recriar (evita conflito no unique).
        const ja = await tx.equipamento_pontos.findFirst({
          where: { equipamento_id: equipId, nome: pt.nome },
          select: { id: true, ativo: true, deleted_at: true },
        });
        if (ja) {
          if (!ja.ativo || ja.deleted_at) {
            await tx.equipamento_pontos.update({
              where: { id: ja.id },
              data: {
                tipo: pt.tipo,
                unidade: pt.unidade,
                ordem: pt.ordem,
                ativo: true,
                deleted_at: null,
              },
            });
          }
          continue;
        }
        await tx.equipamento_pontos.create({
          data: {
            equipamento_id: equipId,
            tipo: pt.tipo,
            nome: pt.nome,
            unidade: pt.unidade,
            ordem: pt.ordem,
            ativo: true,
          },
        });
      }

      // (4) Espelha a CONFIG da bomba na tabela bomba_combustivel_config. A fonte da
      // verdade passou a ser as props do IoT (a aba "Config" do unifilar foi removida);
      // listarBombas e a telemetria consomem essa tabela. Sem UNIQUE em equipamento_id
      // (só PK em id) → checa-existência + UPDATE/INSERT (mesmo padrão do service).
      const nivelMin = Number(props.nivel_min_pct ?? 5) || 5;
      const timeoutS = Math.trunc(Number(props.timeout_s ?? 600)) || 600;
      const kFator = Number(props.k_fator ?? 450) || 450;
      const modoLeitor =
        String(props.modo_leitor ?? 'rs485').trim().slice(0, 12) || 'rs485';
      const temCfg =
        (
          await tx.$queryRaw<Array<{ x: number }>>`
            SELECT 1 AS x FROM bomba_combustivel_config
            WHERE TRIM(equipamento_id) = ${equipId} LIMIT 1`
        ).length > 0;
      if (temCfg) {
        await tx.$executeRaw`
          UPDATE bomba_combustivel_config
          SET nivel_min_pct = ${nivelMin}, timeout_s = ${timeoutS},
              k_fator = ${kFator}, rfid_mode = ${modoLeitor}, updated_at = now()
          WHERE TRIM(equipamento_id) = ${equipId}`;
      } else {
        await tx.$executeRaw`
          INSERT INTO bomba_combustivel_config
            (id, equipamento_id, nivel_min_pct, timeout_s, k_fator, rfid_mode)
          VALUES (${this.generateId()}, ${equipId}, ${nivelMin}, ${timeoutS}, ${kFator}, ${modoLeitor})`;
      }
    }
  }

  /**
   * Carregador Elétrico: espelha a bomba. Auto-cria/reusa o equipamento, liga
   * automacao, semeia os pontos do catálogo (bo Habilitar/Desabilitar, bi Conectado)
   * pro Configurar BOs/BIs da TON, e sincroniza carregador_config das props do IoT
   * (fonte kWh, tarifa, potência, tópico). Idempotente (roda a cada save).
   */
  private async ensureCarregadorEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const comps = diagrama.components as Array<Record<string, any>>;
    const cars = comps.filter(
      (c) => String(c?.type ?? '').toLowerCase() === 'carregador',
    );
    if (cars.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    const tipoCar = await tx.tipos_equipamentos.findFirst({
      where: { codigo: 'CARREGADOR_ELETRICO' },
      select: { id: true },
    });
    const tipoCarId = tipoCar?.id?.trim() || null;

    const jaReferenciados = new Set<string>(
      comps
        .map((c) => this.rawEquipamentoId(c as unknown as IotDiagramaComponent) ?? '')
        .filter(Boolean),
    );

    type PontoDef = { tipo: string; nome: string; unidade: string | null; ordem: number };
    const FALLBACK: PontoDef[] = [
      { tipo: 'comando', nome: 'Habilitar', unidade: null, ordem: 1 },
      { tipo: 'comando', nome: 'Desabilitar', unidade: null, ordem: 2 },
      { tipo: 'status', nome: 'Conectado', unidade: null, ordem: 1 },
    ];
    const cat = await tx.iot_device_tipos.findFirst({
      where: { codigo: 'carregador_eletrico' },
      select: { pontos: true },
    });
    const cp = (cat?.pontos ?? null) as {
      bo?: Array<{ id?: string; label?: string; unit?: string }>;
      bi?: Array<{ id?: string; label?: string; unit?: string }>;
    } | null;
    const mapCat = (
      arr: Array<{ id?: string; label?: string; unit?: string }> | undefined,
      tipo: string,
    ): PontoDef[] =>
      (arr ?? [])
        .map((p, i) => ({ tipo, nome: String(p.label ?? p.id ?? '').trim(), unidade: p.unit ?? null, ordem: i + 1 }))
        .filter((p) => !!p.nome);
    const doCat: PontoDef[] = [...mapCat(cp?.bo, 'comando'), ...mapCat(cp?.bi, 'status')];
    const PONTOS: PontoDef[] = doCat.length > 0 ? doCat : FALLBACK;

    for (const comp of cars) {
      const props = (comp.props ?? {}) as Record<string, unknown>;
      let equipId = this.rawEquipamentoId(comp as unknown as IotDiagramaComponent);
      if (equipId) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: equipId, deleted_at: null },
          select: { id: true },
        });
        if (!ok) equipId = null;
      }
      if (!equipId) {
        const reusavel = unidadeId
          ? await tx.equipamentos.findFirst({
              where: {
                unidade_id: unidadeId,
                deleted_at: null,
                id: { notIn: Array.from(jaReferenciados) },
                ...(tipoCarId
                  ? { tipo_equipamento_id: tipoCarId }
                  : { tipo_equipamento: 'CARREGADOR_ELETRICO' }),
              },
              select: { id: true },
              orderBy: { created_at: 'asc' },
            })
          : null;
        if (reusavel) {
          equipId = reusavel.id.trim();
        } else {
          const nome =
            String(props.name ?? 'Carregador Elétrico').trim() || 'Carregador Elétrico';
          const novo = await tx.equipamentos.create({
            data: {
              id: this.generateId(),
              nome,
              classificacao: 'UC',
              criticidade: '3',
              tipo_equipamento: 'CARREGADOR_ELETRICO',
              mqtt_habilitado: false,
              automacao: true,
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              ...(tipoCarId ? { tipo_equipamento_id: tipoCarId } : {}),
            },
            select: { id: true },
          });
          equipId = novo.id.trim();
        }
        jaReferenciados.add(equipId);
        (comp as { props?: Record<string, unknown> }).props = {
          ...props,
          equipamento_id: equipId,
        };
      }

      const eq = await tx.equipamentos.findFirst({
        where: { id: equipId, deleted_at: null },
        select: { id: true, automacao: true },
      });
      if (!eq) continue;
      if (!eq.automacao) {
        await tx.equipamentos.update({ where: { id: equipId }, data: { automacao: true } });
      }

      for (const pt of PONTOS) {
        const ja = await tx.equipamento_pontos.findFirst({
          where: { equipamento_id: equipId, nome: pt.nome },
          select: { id: true, ativo: true, deleted_at: true },
        });
        if (ja) {
          if (!ja.ativo || ja.deleted_at) {
            await tx.equipamento_pontos.update({
              where: { id: ja.id },
              data: { tipo: pt.tipo, unidade: pt.unidade, ordem: pt.ordem, ativo: true, deleted_at: null },
            });
          }
          continue;
        }
        await tx.equipamento_pontos.create({
          data: { equipamento_id: equipId, tipo: pt.tipo, nome: pt.nome, unidade: pt.unidade, ordem: pt.ordem, ativo: true },
        });
      }

      // Espelha config nas tabelas (fonte da verdade = props do IoT).
      const fonte =
        String(props.fonte_kwh ?? 'ton').trim() === 'carregador' ? 'carregador' : 'ton';
      const tarifaN = Number(props.tarifa_kwh);
      const tarifaV = Number.isFinite(tarifaN) ? tarifaN : null;
      const potN = Number(props.potencia_kw);
      const potV = Number.isFinite(potN) ? potN : null;
      const topico = String(props.topico_energia ?? '').trim() || null;
      const temCfg =
        (
          await tx.$queryRaw<Array<{ x: number }>>`
            SELECT 1 AS x FROM carregador_config WHERE TRIM(equipamento_id) = ${equipId} LIMIT 1`
        ).length > 0;
      if (temCfg) {
        await tx.$executeRaw`
          UPDATE carregador_config
          SET fonte_kwh = ${fonte}, tarifa_kwh = ${tarifaV}, potencia_kw = ${potV},
              topico_energia = ${topico}, updated_at = now()
          WHERE TRIM(equipamento_id) = ${equipId}`;
      } else {
        await tx.$executeRaw`
          INSERT INTO carregador_config (id, equipamento_id, fonte_kwh, tarifa_kwh, potencia_kw, topico_energia)
          VALUES (${this.generateId()}, ${equipId}, ${fonte}, ${tarifaV}, ${potV}, ${topico})`;
      }
    }
  }

  /**
   * Auto-cria (ou re-vincula) o equipamento de cada DEVICE Modbus do diagrama
   * (rele, medidor, inversor...) que ainda nao tem equipamento_id valido.
   *
   * POR QUE: um componente sem equipamento e' "so desenho" — a telemetria dele
   * nao tem onde pousar no banco e a tela nao tem de quem assinar (foi
   * exatamente o buraco que escondeu o status do disjuntor). Antes isso dependia
   * de um passo MANUAL (dialogo "associar") que dava pra pular em silencio. A TON
   * ja fazia automatico (ensureTonEquipamentos); aqui vale o mesmo pros devices.
   *
   * O topico e' derivado da TON que le o device (BFS nas conexoes do diagrama),
   * no MESMO formato que o firmware publica e que os devices existentes usam:
   *   `<ton.mqtt_topic_base>/<name>_<modbus_address>/data`
   *
   * Idempotente (roda a cada save): (1) equipamento_id valido -> pula;
   * (2) existe equipamento com o mesmo topico -> REUSA; (3) senao cria.
   */
  private async ensureDeviceEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;

    const isTon = (t: unknown) =>
      String(t ?? '')
        .toLowerCase()
        .startsWith('ton');
    const comps = diagrama.components as Array<Record<string, any>>;

    // Device Modbus = tem endereco Modbus e modelo do catalogo (nao e' TON).
    const devices = comps.filter((c) => {
      if (isTon(c?.type)) return false;
      const p = (c?.props ?? {}) as Record<string, unknown>;
      return (
        String(p.modbus_address ?? '').trim() !== '' &&
        String(p.catalog_id ?? '').trim() !== ''
      );
    });
    if (devices.length === 0) return;

    // Adjacencia pra achar, por topologia, a TON que le cada device.
    const adj = new Map<string, string[]>();
    for (const cx of (diagrama.connections ?? []) as Array<any>) {
      const a = cx?.from?.componentId;
      const b = cx?.to?.componentId;
      if (!a || !b) continue;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
    const byId = new Map<string, Record<string, any>>(comps.map((c) => [String(c?.id), c]));
    const tonTopicDe = (startId: string): string | null => {
      const visto = new Set<string>([startId]);
      const fila: string[] = [startId];
      while (fila.length) {
        const id = fila.shift() as string;
        const c = byId.get(id);
        if (c && id !== startId && isTon(c.type)) {
          const t = String(c.props?.mqtt_topic_base ?? '').trim();
          if (t) return t;
        }
        for (const viz of adj.get(id) ?? []) {
          if (!visto.has(viz)) {
            visto.add(viz);
            fila.push(viz);
          }
        }
      }
      return null;
    };

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;

    for (const comp of devices) {
      const rawEquip = this.rawEquipamentoId(comp as unknown as IotDiagramaComponent);
      if (rawEquip) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: rawEquip, deleted_at: null },
          select: { id: true },
        });
        if (ok) continue;
      }

      const props = (comp.props ?? {}) as Record<string, unknown>;
      const base = tonTopicDe(String(comp.id));
      if (!base) continue; // device solto (sem TON conectada) — sem topico derivavel

      const nome =
        String(props.name ?? props.catalog_id ?? comp.type ?? 'Device').trim() || 'Device';
      const addr = String(props.modbus_address ?? '').trim();
      const topico = `${base}/${nome}_${addr}/data`;

      let equipId: string;
      const existente = await tx.equipamentos.findFirst({
        where: { topico_mqtt: topico, deleted_at: null },
        select: { id: true },
      });
      if (existente) {
        equipId = existente.id.trim();
      } else {
        const novo = await tx.equipamentos.create({
          data: {
            id: this.generateId(),
            nome,
            classificacao: 'UC',
            criticidade: '3',
            tipo_equipamento: String(comp.type ?? '').toUpperCase(),
            mqtt_habilitado: true,
            automacao: false,
            topico_mqtt: topico,
            ...(unidadeId ? { unidade_id: unidadeId } : {}),
          },
          select: { id: true },
        });
        equipId = novo.id.trim();
        console.log(
          `🔧 [IoT] equipamento auto-criado p/ device "${nome}" (${topico}) — antes era so desenho`,
        );
      }

      comp.props = { ...props, equipamento_id: equipId };
    }
  }

  /**
   * Reescreve iot_componentes + iot_conexoes do projeto a partir do diagrama.
   * Chamado dentro da transacao do updateProjeto.
   */
  private async syncRelational(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    await tx.iot_conexoes.deleteMany({ where: { projeto_id: projetoId } });
    await tx.iot_componentes.deleteMany({ where: { projeto_id: projetoId } });

    if (!Array.isArray(diagrama.components) || diagrama.components.length === 0) {
      return;
    }

    // Pre-resolve equipamento_ids via existence check em equipamentos.
    // Handles CHAR(26) padding e ids invalidos sem quebrar a transacao.
    const requestedEquipIds = new Set<string>();
    for (const comp of diagrama.components) {
      const raw = this.rawEquipamentoId(comp);
      if (raw) requestedEquipIds.add(raw);
    }
    const validEquipIds = new Set<string>();
    if (requestedEquipIds.size > 0) {
      const found = await tx.equipamentos.findMany({
        where: { id: { in: Array.from(requestedEquipIds) }, deleted_at: null },
        select: { id: true },
      });
      for (const e of found) validEquipIds.add(e.id.trim());
    }

    const idMapping = new Map<string, string>();
    for (const comp of diagrama.components) {
      const dbId = this.generateId();
      const localId = String(comp.id);
      idMapping.set(localId, dbId);

      const rawEquip = this.rawEquipamentoId(comp);
      const equipamentoId =
        rawEquip && validEquipIds.has(rawEquip) ? rawEquip : null;

      await tx.iot_componentes.create({
        data: {
          id: dbId,
          projeto_id: projetoId,
          tipo: comp.type,
          x: typeof comp.x === 'number' ? comp.x : 0,
          y: typeof comp.y === 'number' ? comp.y : 0,
          equipamento_id: equipamentoId,
          props: this.extractComponentProps(comp) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (!Array.isArray(diagrama.connections)) return;

    for (const conn of diagrama.connections) {
      const fromRef = this.parseConnectionRef(conn.from);
      const toRef = this.parseConnectionRef(conn.to);
      if (!fromRef || !toRef) continue;

      const fromCompId = idMapping.get(fromRef.componentId);
      const toCompId = idMapping.get(toRef.componentId);
      if (!fromCompId || !toCompId) continue;

      await tx.iot_conexoes.create({
        data: {
          id: this.generateId(),
          projeto_id: projetoId,
          from_comp_id: fromCompId,
          from_port: this.truncatePort(fromRef.port),
          to_comp_id: toCompId,
          to_port: this.truncatePort(toRef.port),
          estilo: typeof conn.style === 'string' ? conn.style.slice(0, 20) : 'rs485',
        },
      });
    }
  }

  /**
   * Extrai equipamento_id bruto (texto trimado) do component.
   * NAO valida formato — validacao acontece via SELECT em equipamentos
   * dentro da transacao (lida com CHAR(26) padding e ids garbage).
   * Aceita o id em comp.props.equipamento_id ou no proprio comp.equipamento_id.
   */
  private rawEquipamentoId(comp: IotDiagramaComponent): string | null {
    const props = (comp as Record<string, unknown>).props;
    const fromProps =
      props && typeof props === 'object'
        ? (props as Record<string, unknown>).equipamento_id
        : undefined;
    const fromTop = (comp as Record<string, unknown>).equipamento_id;
    const raw = typeof fromProps === 'string' ? fromProps : fromTop;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** Coleta atributos custom do componente (tudo exceto id/type/x/y) para gravar em iot_componentes.props. */
  private extractComponentProps(comp: IotDiagramaComponent): Record<string, unknown> {
    const { id: _id, type: _type, x: _x, y: _y, props, ...rest } = comp;
    const merged: Record<string, unknown> = { ...rest };
    if (props && typeof props === 'object') {
      Object.assign(merged, props as Record<string, unknown>);
    }
    return merged;
  }

  /** Parse das duas formas que `connection.from`/`connection.to` aparecem no JSON. */
  private parseConnectionRef(
    ref: unknown,
  ): { componentId: string; port?: string } | null {
    if (ref === null || ref === undefined) return null;
    if (typeof ref === 'string' || typeof ref === 'number') {
      return { componentId: String(ref) };
    }
    if (typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      const compId = obj.componentId ?? obj.id;
      if (compId === undefined || compId === null) return null;
      const port = typeof obj.port === 'string' ? obj.port : undefined;
      return { componentId: String(compId), port };
    }
    return null;
  }

  private truncatePort(port: string | undefined): string {
    if (!port) return '';
    return port.slice(0, 10);
  }

  /** Cast da linha do Prisma para o shape consumido pelo frontend. */
  private toProjetoRow = (row: {
    id: string;
    unidade_id: string;
    nome: string;
    diagrama: Prisma.JsonValue;
    created_at: Date;
    updated_at: Date;
  }): IotProjetoRow => ({
    id: row.id,
    unidade_id: row.unidade_id,
    nome: row.nome,
    diagrama: (row.diagrama ?? EMPTY_DIAGRAMA) as unknown as IotDiagrama,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
