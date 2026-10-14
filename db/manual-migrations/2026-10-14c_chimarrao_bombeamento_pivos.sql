-- Chimarrão "Pivos 1,2,3,11": bombeamento de cada pivô (funcionalidade do pivô).
-- Campo (14/10): pivôs 1 e 2 dividem a bomba (dois motores que trabalham juntos; a
-- escolha de qual pivô recebe água é manual no pé do pivô) → os dois mandam "ligar
-- bomba" na MESMA TON. Pivôs 3 e 11 também dividem (chave de direcionamento da água —
-- automação futura).
-- TONs da casa de bombas (satélites LoRa da gateway TON2-1), piloto dos SoftStarters:
-- BO1 = ligar, BO2 = desligar (pulso), BI1 = "Ligado".
--   PIVO_1 + PIVO 2   → TON4-1 (…/satellite/28:37:2F:9D:8C:5C)
--   PIVO_3 + PIVO_11  → TON4-3 (…/satellite/28:37:2F:9D:82:C0)
-- Mesma TON + mesma BO de ligar = bomba compartilhada (desligar um pivô não desliga a
-- bomba se o outro estiver girando). Só grava configuração (nenhum comando é enviado).
BEGIN;
INSERT INTO pivo_config (equipamento_id, bombeamento, sequencia, updated_at)
SELECT p.id,
       jsonb_build_object('ativo', true, 'ton_id', trim(t.id), 'modo', 'pulso', 'bo_liga', 1, 'bo_desliga', 2,
                          'bi_confirma', 1, 'confirma_s', 30, 'pulso_ms', 1000),
       '{"pressurizacao_s": 120, "confirma_giro_s": 30}'::jsonb, now()
FROM (VALUES ('cmkmz51ts09rujqv9crh8dag9', 'OLI/GO/CHIMARRAO/BOMBAS/satellite/28:37:2F:9D:8C:5C'),   -- PIVO_1
             ('cmkmz5o5k09s2jqv9y9ik8vcd', 'OLI/GO/CHIMARRAO/BOMBAS/satellite/28:37:2F:9D:8C:5C'),   -- PIVO 2
             ('cmkmzeuz509uwjqv9pzuoy94k', 'OLI/GO/CHIMARRAO/BOMBAS/satellite/28:37:2F:9D:82:C0'),   -- PIVO_3
             ('cmltz24sa029ojq563z1h9u1l', 'OLI/GO/CHIMARRAO/BOMBAS/satellite/28:37:2F:9D:82:C0'))   -- PIVO_11
     AS v(pivo, topico)
JOIN equipamentos p ON p.id = v.pivo::bpchar AND p.deleted_at IS NULL
JOIN equipamentos t ON t.topico_mqtt = v.topico AND t.deleted_at IS NULL
ON CONFLICT (equipamento_id) DO UPDATE SET bombeamento = EXCLUDED.bombeamento,
  sequencia = COALESCE(pivo_config.sequencia, EXCLUDED.sequencia), updated_at = now();
COMMIT;
