-- Unifilar: o motor (bomba) que alimentava cada pivô sai do desenho; o pivô passa a ser
-- o símbolo único (o bombeamento é configuração do pivô — pivo_config.bombeamento).
-- Para cada MOTOR desenhado cuja saída (porta bottom) vai a um PIVÔ ou a um nó de junção:
--   a linha que entrava no motor (porta top) passa a ir direto ao que estava abaixo dele;
--   a linha motor→abaixo e o motor são soft-deletados.
-- Motores sem pivô (UBS, MOT-01 do Lab) ficam intactos.
-- Os motores afetados não têm pontos, dados, filhos nem vínculos (conferido 14/10).
-- Backup: bkp_20261014_motor_pivo_conexoes / _equipamentos. ROLLBACK no fim do arquivo.
-- Simular sem gravar: sed 's/^COMMIT;$/ROLLBACK;/' este_arquivo | psql ...
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261014_motor_pivo_conexoes AS SELECT * FROM equipamentos_conexoes WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261014_motor_pivo_equipamentos AS SELECT * FROM equipamentos WITH NO DATA;

DO $$
DECLARE
  m record; up record; dn record; n int := 0;
  o_id bpchar; o_porta text; o_tipo text; o_gx int; o_gy int;
BEGIN
  FOR m IN
    SELECT e.id, trim(e.nome) AS nome FROM equipamentos e
    JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
    WHERE t.codigo = 'MOTOR' AND e.deleted_at IS NULL AND e.posicao_x IS NOT NULL
  LOOP
    -- conexão na porta de BAIXO do motor (motor como origem OU destino)
    dn := NULL;
    SELECT * INTO dn FROM equipamentos_conexoes c
     WHERE c.deleted_at IS NULL
       AND ((c.equipamento_origem_id = m.id AND c.porta_origem = 'bottom')
         OR (c.equipamento_destino_id = m.id AND c.porta_destino = 'bottom'))
     LIMIT 1;
    CONTINUE WHEN dn.id IS NULL;
    -- o "outro lado" da conexão de baixo
    IF dn.equipamento_origem_id = m.id THEN
      o_id := dn.equipamento_destino_id; o_porta := dn.porta_destino; o_tipo := dn.destino_tipo; o_gx := dn.destino_grid_x; o_gy := dn.destino_grid_y;
    ELSE
      o_id := dn.equipamento_origem_id; o_porta := dn.porta_origem; o_tipo := dn.origem_tipo; o_gx := dn.origem_grid_x; o_gy := dn.origem_grid_y;
    END IF;
    -- só motor que alimenta PIVÔ (direto) ou um nó de junção
    CONTINUE WHEN NOT (
      (o_id IS NOT NULL AND EXISTS (SELECT 1 FROM equipamentos x JOIN tipos_equipamentos tx ON tx.id = x.tipo_equipamento_id WHERE x.id = o_id AND tx.codigo = 'PIVO'))
      OR (o_id IS NULL AND COALESCE(o_tipo, '') <> 'equipamento'));

    up := NULL;
    SELECT * INTO up FROM equipamentos_conexoes c
     WHERE c.deleted_at IS NULL AND c.id <> dn.id
       AND ((c.equipamento_origem_id = m.id AND c.porta_origem = 'top')
         OR (c.equipamento_destino_id = m.id AND c.porta_destino = 'top'))
     LIMIT 1;

    INSERT INTO bkp_20261014_motor_pivo_conexoes SELECT * FROM equipamentos_conexoes WHERE id IN (dn.id, up.id);
    INSERT INTO bkp_20261014_motor_pivo_equipamentos SELECT * FROM equipamentos WHERE id = m.id;

    IF up.id IS NOT NULL THEN
      IF up.equipamento_destino_id = m.id THEN
        UPDATE equipamentos_conexoes SET equipamento_destino_id = o_id, porta_destino = o_porta,
          destino_tipo = o_tipo, destino_grid_x = o_gx, destino_grid_y = o_gy, updated_at = now() WHERE id = up.id;
      ELSE
        UPDATE equipamentos_conexoes SET equipamento_origem_id = o_id, porta_origem = o_porta,
          origem_tipo = o_tipo, origem_grid_x = o_gx, origem_grid_y = o_gy, updated_at = now() WHERE id = up.id;
      END IF;
    END IF;
    UPDATE equipamentos_conexoes SET deleted_at = now(), updated_at = now() WHERE id = dn.id;
    UPDATE equipamentos SET deleted_at = now(), updated_at = now() WHERE id = m.id;
    n := n + 1;
    RAISE NOTICE 'motor % (%) fundido: entrada religada a %', m.nome, trim(m.id),
      COALESCE((SELECT trim(nome) FROM equipamentos WHERE id = o_id), 'nó de junção');
  END LOOP;
  RAISE NOTICE 'total: % motor(es) fundidos', n;
END $$;
COMMIT;

-- ROLLBACK:
-- BEGIN;
-- UPDATE equipamentos_conexoes c SET equipamento_origem_id=b.equipamento_origem_id, porta_origem=b.porta_origem, origem_tipo=b.origem_tipo,
--   origem_grid_x=b.origem_grid_x, origem_grid_y=b.origem_grid_y, equipamento_destino_id=b.equipamento_destino_id, porta_destino=b.porta_destino,
--   destino_tipo=b.destino_tipo, destino_grid_x=b.destino_grid_x, destino_grid_y=b.destino_grid_y, deleted_at=b.deleted_at
--   FROM bkp_20261014_motor_pivo_conexoes b WHERE b.id=c.id;
-- UPDATE equipamentos e SET deleted_at=NULL FROM bkp_20261014_motor_pivo_equipamentos b WHERE b.id=e.id;
-- COMMIT;
