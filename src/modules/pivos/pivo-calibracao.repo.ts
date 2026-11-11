/**
 * Leitura da tabela calibracao_angulo (NEXON-103, SQL 2026-11-11c) — fora do schema
 * Prisma, como as demais pivo_*. Tabela ausente (SQL não aplicado) = sem calibração:
 * quem lê nunca derruba o estado do pivô por causa dela.
 */
import { colunaTrilhaAusente } from '../logs-mqtt/logs-mqtt-filtros';
import type { Sentido } from './pivo-calibracao.util';

export interface LinhaCalibracao {
  id: string;
  equipamento_id: string;
  bruto_cal: number;
  sentido: Sentido;
  centro_lat: number;
  centro_lon: number;
  ponta_lat: number;
  ponta_lon: number;
  az_cal: number;
  resolucao: number;
  zero: number;
  encoder_equipamento_id: string | null;
  leituras: number[] | null;
  origem: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  criado_em: Date;
  ativa: boolean;
  desativada_em: Date | null;
  motivo_desativacao: string | null;
}

/** Só o que estas consultas usam do PrismaService (os specs passam um fake). */
export interface PrismaRaw {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: any[]): Promise<number>;
}

function linha(r: any): LinhaCalibracao {
  return {
    id: String(r.id).trim(),
    equipamento_id: String(r.equipamento_id).trim(),
    bruto_cal: Number(r.bruto_cal),
    sentido: Number(r.sentido) === -1 ? -1 : 1,
    centro_lat: Number(r.centro_lat),
    centro_lon: Number(r.centro_lon),
    ponta_lat: Number(r.ponta_lat),
    ponta_lon: Number(r.ponta_lon),
    az_cal: Number(r.az_cal),
    resolucao: Number(r.resolucao),
    zero: Number(r.zero),
    encoder_equipamento_id: r.encoder_equipamento_id ? String(r.encoder_equipamento_id).trim() : null,
    leituras: Array.isArray(r.leituras) ? r.leituras.map(Number) : null,
    origem: String(r.origem ?? 'calibracao'),
    usuario_id: r.usuario_id ? String(r.usuario_id).trim() : null,
    usuario_nome: r.usuario_nome ? String(r.usuario_nome).trim() : null,
    criado_em: r.criado_em,
    ativa: r.ativa === true,
    desativada_em: r.desativada_em ?? null,
    motivo_desativacao: r.motivo_desativacao ?? null,
  };
}

/** Calibração vigente do pivô (a única ativa), ou null. */
export async function calibracaoVigente(prisma: PrismaRaw, pivoId: string): Promise<LinhaCalibracao | null> {
  try {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT c.*, u.nome AS usuario_nome FROM calibracao_angulo c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.equipamento_id = ${pivoId}::bpchar AND c.ativa
      ORDER BY c.criado_em DESC LIMIT 1`;
    return rows?.[0] ? linha(rows[0]) : null;
  } catch (e) {
    if (colunaTrilhaAusente(e)) return null;
    throw e;
  }
}

/** A última calibração desativada do pivô (a que o "Restaurar calibração anterior" reativa), ou null. */
export async function calibracaoAnterior(prisma: PrismaRaw, pivoId: string): Promise<LinhaCalibracao | null> {
  try {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT c.*, u.nome AS usuario_nome FROM calibracao_angulo c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.equipamento_id = ${pivoId}::bpchar AND NOT c.ativa
      ORDER BY c.desativada_em DESC NULLS LAST, c.criado_em DESC LIMIT 1`;
    return rows?.[0] ? linha(rows[0]) : null;
  } catch (e) {
    if (colunaTrilhaAusente(e)) return null;
    throw e;
  }
}

/**
 * Desativa a calibração vigente (trocaram o encoder ou a resolução na Configuração):
 * a contagem deixa de valer para o azimute gravado. Devolve quantas desativou.
 */
export async function desativarCalibracao(prisma: PrismaRaw, pivoId: string, usuarioId: string | null, motivo: string): Promise<number> {
  try {
    return await prisma.$executeRaw`
      UPDATE calibracao_angulo SET ativa = false, desativada_em = now(), desativada_por = ${usuarioId}, motivo_desativacao = ${motivo}
      WHERE equipamento_id = ${pivoId}::bpchar AND ativa`;
  } catch (e) {
    if (colunaTrilhaAusente(e)) return 0;
    throw e;
  }
}
