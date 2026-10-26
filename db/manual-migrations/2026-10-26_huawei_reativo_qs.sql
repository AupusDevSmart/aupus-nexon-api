-- Reativo Q/S nos Huawei (SUN2000 M1/M2/75KTL) e WEG SIW500H (mapa Huawei): registrador 40123
-- "Reactive Power Compensation (Q/S)", I16, ganho 1000 (manual Huawei Modbus Interface
-- Definitions V3.0, 2023-01-17). Q/S = fração de Smax: 50% → 500. UI em % (escala 10).
-- 42014 (Remote power scheduling) NÃO entra: o manual não lista os valores e desabilitar trava o
-- inversor. Conferir habilitado pelo app FusionSolar/SmartLogger antes de usar limite/FP/Q.
CREATE TABLE IF NOT EXISTS bkp_20261026_iot_modelos_huawei_qs AS
  SELECT id, mapeamento FROM iot_device_modelos
  WHERE id IN ('iot_modelo_huawei100m2____', '72b9250ecfebc20237916e003e', '8c3b4334d0d7ff63cdaa671f06', 'c3b2f0b857006c61b7d967d85b');

UPDATE iot_device_modelos m SET mapeamento = jsonb_set(
    jsonb_set(m.mapeamento, '{bo_map,sp_q_pct}',
      '{"func": 6, "register": 40123, "value": "$valor", "min": -1000, "max": 1000}'::jsonb, true),
    '{setpoints}',
    (SELECT jsonb_agg(s) FROM jsonb_array_elements(m.mapeamento->'setpoints') s WHERE s->>'id' <> 'sp_q_pct')
      || '[{"id": "sp_q_pct", "label": "Reativo (% da nominal)", "unidade": "%", "escala": 10, "min": -100, "max": 100, "padrao": 0,
           "obs": "40123 Q/S (×1000, fração de Smax). Ao usar, o FP fixo deixa de valer (vale o último enviado). O inversor recusa fora da faixa da rede. Sinal (capacitivo × indutivo): conferir no primeiro teste. Exige Remote power scheduling (42014) habilitado."}]'::jsonb),
  updated_at = now()
WHERE m.id IN ('iot_modelo_huawei100m2____', '72b9250ecfebc20237916e003e', '8c3b4334d0d7ff63cdaa671f06', 'c3b2f0b857006c61b7d967d85b');
