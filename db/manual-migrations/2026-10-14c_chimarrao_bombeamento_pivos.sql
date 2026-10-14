-- Chimarrão "Pivos 1,2,3,11": bombeamento de cada pivô a partir do piloto dos SoftStarters
-- (TON4 da casa de bombas: BO1 = ligar, BO2 = desligar, pulso; BI1 = "Ligado").
--   PIVO_1            → TON4-1 (…8C:5C)
--   PIVO_3 + PIVO_11  → TON4-3 (…82:C0)  — mesma TON+BO = bomba compartilhada
--   PIVO 2            → PENDENTE: a TON4-2 (…5B:A4) foi removida do cadastro.
-- Só grava configuração (nenhum comando é enviado).
BEGIN;
INSERT INTO pivo_config (equipamento_id, bombeamento, sequencia, updated_at)
SELECT p.id,
       jsonb_build_object('ativo', true, 'ton_id', trim(t.id), 'modo', 'pulso', 'bo_liga', 1, 'bo_desliga', 2,
                          'bi_confirma', 1, 'confirma_s', 30, 'pulso_ms', 1000),
       '{"pressurizacao_s": 120, "confirma_giro_s": 30}'::jsonb, now()
FROM (VALUES ('cmkmz51ts09rujqv9crh8dag9', 'TON4-1'),   -- PIVO_1
             ('cmkmzeuz509uwjqv9pzuoy94k', 'TON4-3'),   -- PIVO_3
             ('cmltz24sa029ojq563z1h9u1l', 'TON4-3'))   -- PIVO_11
     AS v(pivo, ton)
JOIN equipamentos p ON p.id = v.pivo::bpchar AND p.deleted_at IS NULL
JOIN equipamentos t ON trim(t.nome) = v.ton AND t.deleted_at IS NULL AND t.topico_mqtt LIKE 'OLI/GO/CHIMARRAO/BOMBAS/satellite/%'
ON CONFLICT (equipamento_id) DO UPDATE SET bombeamento = EXCLUDED.bombeamento,
  sequencia = COALESCE(pivo_config.sequencia, EXCLUDED.sequencia), updated_at = now();
COMMIT;
