-- Sungrow SG75CX/SG110CX/SG250CX/SG333HX: remove "potencia_aparente2" do ai_map (19/11/2026).
-- Era bloco 0 (4999) offset 10 U32 = regs 5010-5011 (doc), mistura a palavra baixa da potência aparente (5009-5010)
-- com a tensão do MPPT1 (5011): valor sem sentido, ninguém consome. A potência aparente certa é apparent_total
-- (= potencia_aparente, offset 9). No emulador, o ponto sobrescrevia S e MPPT1. Vale para firmware gerado depois.
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261119_sungrow_ai_map AS
SELECT id, modelo, mapeamento, now() AS salvo_em FROM iot_device_modelos WHERE mapeamento->'ai_map' ? 'potencia_aparente2';

UPDATE iot_device_modelos
SET mapeamento = jsonb_set(mapeamento, '{ai_map}', (mapeamento->'ai_map') - 'potencia_aparente2'), updated_at = now()
WHERE mapeamento->'ai_map' ? 'potencia_aparente2';
COMMIT;

SELECT modelo, mapeamento->'ai_map' ? 'potencia_aparente2' AS ainda_tem FROM iot_device_modelos WHERE fabricante ILIKE '%sungrow%';
