/**
 * Detector de frame de inversor com overflow UINT do Modbus (leitura corrompida).
 *
 * Erro de leitura recorrente (UFV Aupus II: 42 frames em 30 dias, ~1.4/dia nos
 * inversores): uma fatia do registro Modbus estoura e os campos derivados ficam
 * com assinatura de wrap UINT (2^32, 2^16/10, 0xffff). O frame e gravado com
 * qualidade='bom', entao precisa ser detectado por VALOR. Usado:
 *  - na ingestao (mqtt.service.ts) para descartar o frame antes de gravar;
 *  - em qualquer agregacao que some potencia/energia direto (coa.service.ts).
 *
 * Os filtros read-time em SQL (potencia_ativa_kw < CAP) continuam como rede de
 * seguranca pro historico ja gravado.
 */
export function detectarOverflowUint(payload: any): { glitch: boolean; motivos: string[] } {
  const motivos: string[] = [];
  const e = payload?.energy ?? {};
  const i = payload?.info ?? {};
  const s = payload?.status ?? {};
  const p = payload?.power ?? {};

  // Assinaturas exatas de wrap UINT.
  if (e.total_yield === 4294967000) motivos.push('total_yield=2^32');
  if (e.daily_yield === 6553.5) motivos.push('daily_yield=2^16/10');
  if (i.output_type === 65535) motivos.push('output_type=2^16');
  if (s.work_state === 65535) motivos.push('work_state=2^16');
  if (i.nominal_power === 6553.5) motivos.push('nominal_power=2^16/10');
  if (i.device_type === 'ffff') motivos.push('device_type=0xffff');

  // Limites de sanidade — capturam variantes (UINT24, valores levemente off).
  // Ordens de grandeza acima de qualquer device real (lifetime real ~5e5 kWh).
  if (typeof e.total_yield === 'number' && e.total_yield >= 5e8) motivos.push('total_yield>=5e8');
  if (typeof p.active_total === 'number' && p.active_total >= 1e8) motivos.push('active_total>=1e8');

  return { glitch: motivos.length > 0, motivos };
}

/**
 * Teto absoluto de sanidade: nenhum device real chega a 1 GW; >= isso e overflow.
 * Defesa em profundidade pra quando SO a coluna potencia_ativa_kw esta corrompida
 * e o JSON `dados` nao dispara as assinaturas acima.
 */
export const CAP_POTENCIA_GLITCH_KW = 1_000_000;

/** True se a potencia (kW) e claramente glitch (>= 1 GW em modulo). */
export function ehPotenciaGlitch(potenciaKw: number): boolean {
  return Number.isFinite(potenciaKw) && Math.abs(potenciaKw) >= CAP_POTENCIA_GLITCH_KW;
}
