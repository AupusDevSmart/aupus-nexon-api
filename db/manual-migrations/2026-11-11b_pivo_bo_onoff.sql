-- Pivô: BOs do padrão como saída ON/OFF (alto permanente) = ton_bo.pulso_ms 0.
-- Vale para as BOs ligadas aos pontos Bombeamento, Valvula, Girar_direita, Girar_esquerda,
-- Percentimetro e Canhao de qualquer pivô (hoje: Lab - NexON / PIV-01). Idempotente.
BEGIN;
CREATE TEMP TABLE _tons ON COMMIT DROP AS
SELECT DISTINCT b.ton_id FROM ton_bo b
JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
JOIN equipamentos e ON e.id = p.equipamento_id
LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
WHERE b.deleted_at IS NULL AND UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%'
  AND p.nome IN ('Bombeamento', 'Valvula', 'Girar_direita', 'Girar_esquerda', 'Percentimetro', 'Canhao')
  AND b.pulso_ms <> 0
  AND NOT EXISTS (SELECT 1 FROM equipamento_pontos q WHERE q.equipamento_id = e.id AND q.nome = 'Desligar' AND q.deleted_at IS NULL); -- painel com Desligar (pulso) fica como está
UPDATE ton_bo b SET pulso_ms = 0, updated_at = now()
FROM equipamento_pontos p
WHERE p.id = b.equipamento_ponto_id AND b.deleted_at IS NULL AND b.ton_id IN (SELECT ton_id FROM _tons)
  AND p.nome IN ('Bombeamento', 'Valvula', 'Girar_direita', 'Girar_esquerda', 'Percentimetro', 'Canhao');
-- espelho iot_vinculos (params.pulso_ms) dessas TONs
UPDATE iot_vinculos v SET params = v.params || '{"pulso_ms": 0}'::jsonb, updated_at = now()
FROM ton_bo b
WHERE v.fonte_tipo = 'ton_bo' AND v.fonte_equipamento_id = b.ton_id AND v.canal = b.bo_numero
  AND b.deleted_at IS NULL AND b.pulso_ms = 0 AND b.ton_id IN (SELECT ton_id FROM _tons);
COMMIT;
SELECT TRIM(t.nome) AS ton, 'BO' || b.bo_numero AS bo, p.nome, CASE WHEN b.pulso_ms = 0 THEN 'ON/OFF' ELSE b.pulso_ms || ' ms' END AS modo
FROM ton_bo b JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id JOIN equipamentos t ON t.id = b.ton_id
WHERE b.deleted_at IS NULL AND p.nome IN ('Bombeamento', 'Valvula', 'Girar_direita', 'Girar_esquerda', 'Percentimetro', 'Canhao')
ORDER BY 1, 2;
