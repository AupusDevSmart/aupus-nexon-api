import { Injectable } from '@nestjs/common';
import type { cameras_unidade_config } from '@prisma/client';
import { PrismaService } from '@/core';
import { AGENDA_FIM_PADRAO, AGENDA_INICIO_PADRAO, decidirArmar, hhmm, timeDe } from './cameras-regras';
import type { ConfigUnidadeDto } from './dto/cameras.dto';

export type ConfigUnidade = cameras_unidade_config;

/**
 * cameras_unidade_config: armamento (agenda/manual/desarmado), refletor/sirene (ponto de comando),
 * chamado automático e e-mails. Unidade sem linha usa o padrão (agenda 18:00–06:30) sem gravar.
 */
@Injectable()
export class CamerasConfigService {
  constructor(private readonly prisma: PrismaService) {}

  padrao(unidadeId: string, plantaId: string | null | undefined): ConfigUnidade {
    return {
      unidade_id: unidadeId.trim(),
      planta_id: (plantaId ?? '').trim(),
      armamento_modo: 'agenda',
      armado_manual: false,
      armado_manual_ate: null,
      agenda_inicio: timeDe(AGENDA_INICIO_PADRAO),
      agenda_fim: timeDe(AGENDA_FIM_PADRAO),
      refletor_equipamento_id: null,
      refletor_ponto_id: null,
      sirene_equipamento_id: null,
      sirene_ponto_id: null,
      abrir_chamado: false,
      notificar_emails: [],
      updated_at: new Date(),
      updated_por_id: null,
    };
  }

  async obter(unidadeId: string, plantaId?: string | null): Promise<ConfigUnidade> {
    const row = await this.prisma.cameras_unidade_config.findUnique({ where: { unidade_id: unidadeId.trim() } });
    return row ?? this.padrao(unidadeId, plantaId);
  }

  /** Objeto "Config da unidade" do contrato. */
  apresentar(c: ConfigUnidade) {
    const agenda =
      c.agenda_inicio || c.agenda_fim
        ? { inicio: hhmm(c.agenda_inicio) ?? AGENDA_INICIO_PADRAO, fim: hhmm(c.agenda_fim) ?? AGENDA_FIM_PADRAO }
        : null;
    return {
      unidade_id: c.unidade_id,
      armamento: {
        modo: c.armamento_modo,
        armado_manual: c.armado_manual,
        armado_manual_ate: c.armado_manual_ate,
        agenda,
      },
      refletor:
        c.refletor_equipamento_id && c.refletor_ponto_id
          ? { equipamento_id: c.refletor_equipamento_id, ponto_id: c.refletor_ponto_id }
          : null,
      sirene:
        c.sirene_equipamento_id && c.sirene_ponto_id
          ? { equipamento_id: c.sirene_equipamento_id, ponto_id: c.sirene_ponto_id }
          : null,
      abrir_chamado: c.abrir_chamado,
      notificar_emails: c.notificar_emails,
      updated_at: c.updated_at,
    };
  }

  /** PUT config: campo ausente mantém o atual; null limpa. Modo agenda sem agenda volta ao padrão. */
  async salvar(unidadeId: string, plantaId: string, dto: ConfigUnidadeDto, userId: string | null): Promise<ConfigUnidade> {
    const id = unidadeId.trim();
    const atual = await this.obter(id, plantaId);
    const arm = dto.armamento;

    const agenda =
      arm.agenda === undefined
        ? { inicio: atual.agenda_inicio, fim: atual.agenda_fim }
        : arm.agenda === null
          ? { inicio: null as Date | null, fim: null as Date | null }
          : { inicio: timeDe(arm.agenda.inicio), fim: timeDe(arm.agenda.fim) };
    if (arm.modo === 'agenda' && (!agenda.inicio || !agenda.fim)) {
      agenda.inicio = timeDe(AGENDA_INICIO_PADRAO);
      agenda.fim = timeDe(AGENDA_FIM_PADRAO);
    }

    const ponto = (
      novo: { equipamento_id: string; ponto_id: string } | null | undefined,
      eqAtual: string | null,
      pontoAtual: string | null,
    ) =>
      novo === undefined
        ? { eq: eqAtual, ponto: pontoAtual }
        : novo === null
          ? { eq: null, ponto: null }
          : { eq: novo.equipamento_id.trim(), ponto: novo.ponto_id.trim() };
    const refletor = ponto(dto.refletor, atual.refletor_equipamento_id, atual.refletor_ponto_id);
    const sirene = ponto(dto.sirene, atual.sirene_equipamento_id, atual.sirene_ponto_id);

    const emails =
      dto.notificar_emails === undefined
        ? atual.notificar_emails
        : [...new Set(dto.notificar_emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

    const dados = {
      planta_id: plantaId.trim(),
      armamento_modo: arm.modo,
      armado_manual: arm.armado_manual ?? atual.armado_manual,
      armado_manual_ate:
        arm.armado_manual_ate === undefined
          ? atual.armado_manual_ate
          : arm.armado_manual_ate
            ? new Date(arm.armado_manual_ate)
            : null,
      agenda_inicio: agenda.inicio,
      agenda_fim: agenda.fim,
      refletor_equipamento_id: refletor.eq,
      refletor_ponto_id: refletor.ponto,
      sirene_equipamento_id: sirene.eq,
      sirene_ponto_id: sirene.ponto,
      abrir_chamado: dto.abrir_chamado ?? atual.abrir_chamado,
      notificar_emails: emails,
      updated_por_id: userId,
    };
    return this.prisma.cameras_unidade_config.upsert({
      where: { unidade_id: id },
      create: { unidade_id: id, ...dados },
      update: dados,
    });
  }

  /** POST armar: aplica cameras-regras.decidirArmar por cima da config atual. */
  async armar(
    unidadeId: string,
    plantaId: string,
    armado: boolean,
    ate: Date | null,
    userId: string | null,
    agora = new Date(),
  ): Promise<ConfigUnidade> {
    const id = unidadeId.trim();
    const atual = await this.obter(id, plantaId);
    const d = decidirArmar(atual, armado, ate, agora);
    const dados = { planta_id: plantaId.trim(), ...d, updated_por_id: userId };
    return this.prisma.cameras_unidade_config.upsert({
      where: { unidade_id: id },
      create: { unidade_id: id, agenda_inicio: atual.agenda_inicio, agenda_fim: atual.agenda_fim, ...dados },
      update: dados,
    });
  }
}
