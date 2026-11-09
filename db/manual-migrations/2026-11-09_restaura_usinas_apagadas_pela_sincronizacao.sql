-- Restaura plantas/unidades que a sincronização com o Service apagou no NexON em 07/11/2026.
--
-- O que aconteceu:
--   26/10 16:21–16:26 (Brasília): limpeza pela tela do Service apagou 6 plantas e 9 unidades LÁ
--   (usinas que são só do NexON). As exclusões ficaram na fila de sincronização do Service.
--   07/11 17:07–17:15: a sincronização do NexON voltou ao ar (SincronizacaoModule de volta no
--   AppModule, 1d41d0a, ativo no restart do deploy de câmeras) e aplicou as exclusões aqui.
--   Os equipamentos NÃO foram apagados e as TONs seguiram gravando dados: só a planta/unidade
--   ficou marcada como apagada (escondida na tela).
--
-- Este script:
--   1. NÃO gera evento de volta para o Service (sincronizacao.replicando = on);
--   2. desfaz a exclusão só do que foi apagado naquela janela (07/11 20:07–20:16 UTC);
--   3. desliga o vínculo de sincronização desses registros (o Service não os tem mais).
-- Ficam apagados (vazios): Eletroposto, Prime, teste nicolas e a "UFV Solar Power" duplicada.
-- Idempotente.
BEGIN;
SET LOCAL sincronizacao.replicando = 'on';

UPDATE plantas SET deleted_at = NULL
WHERE id IN ('cmp19qmz319z1jqkg95de6vyr',   -- CF Investments
             'cmp5ue0ze0f67jq5zado36ylc',   -- GEM
             'cmp5ulhmm0f8njq5zt807exx5',   -- SAN GERMAN
             'cmls0ktmp0348jqdd3qqur7c2')   -- Eco Energia Usina Solar
  AND deleted_at BETWEEN '2026-11-07 20:07:00' AND '2026-11-07 20:16:00';

UPDATE unidades SET deleted_at = NULL
WHERE id IN ('cmp5h6uhn0auljq5zk0y8xtji',   -- CF Investments 01
             'cmp5het2d0ax9jq5z3j5l2y7s',   -- GEM/CATERETÊ
             'cmsekc7007puu6yksa1gnfshc',   -- San German
             'cmp5hbmh20avzjq5zggnj6avg',   -- San German 02
             'cmt8r8ewd003sjqd0xs9d80jm',   -- Pivô 09 (Fazenda Sete Irmãos)
             'cmt8r1ul6003cjqd0ntl7ijgi')   -- Pivôs 07 e 08 (Fazenda Sete Irmãos)
  AND deleted_at BETWEEN '2026-11-07 20:07:00' AND '2026-11-07 20:16:00';

-- Para de compartilhar com o Service (o Service apagou do lado dele; editar aqui não deve recriar lá)
UPDATE sincronizacao_vinculos SET ativo = false, atualizado_em = now()
WHERE registro_id IN ('cmp19qmz319z1jqkg95de6vyr', 'cmp5ue0ze0f67jq5zado36ylc', 'cmp5ulhmm0f8njq5zt807exx5',
                      'cmls0ktmp0348jqdd3qqur7c2', 'cmp5h6uhn0auljq5zk0y8xtji', 'cmp5het2d0ax9jq5z3j5l2y7s',
                      'cmsekc7007puu6yksa1gnfshc', 'cmp5hbmh20avzjq5zggnj6avg', 'cmt8r8ewd003sjqd0xs9d80jm',
                      'cmt8r1ul6003cjqd0ntl7ijgi')
  AND recurso IN ('plantas', 'unidades');

-- Conferência: deve listar as 10 linhas com deleted_at vazio
SELECT 'planta' AS tipo, nome, deleted_at FROM plantas
 WHERE id IN ('cmp19qmz319z1jqkg95de6vyr','cmp5ue0ze0f67jq5zado36ylc','cmp5ulhmm0f8njq5zt807exx5','cmls0ktmp0348jqdd3qqur7c2')
UNION ALL
SELECT 'unidade', nome, deleted_at FROM unidades
 WHERE id IN ('cmp5h6uhn0auljq5zk0y8xtji','cmp5het2d0ax9jq5z3j5l2y7s','cmsekc7007puu6yksa1gnfshc',
              'cmp5hbmh20avzjq5zggnj6avg','cmt8r8ewd003sjqd0xs9d80jm','cmt8r1ul6003cjqd0ntl7ijgi');

COMMIT;
