-- Pivô: bomba, solenoide e canhão viram pontos do pivô, ligados na Topologia IoT →
-- Configurar I/O (antes: TON + BO escolhidas na Configuração do pivô).
-- docs/IOT-PIVO-LIGAR-BOMBA-CANHAO.md.
--   comando "Ligar_bomba"    = BO que liga a bomba (sem Desligar_bomba: fica mantida)
--   comando "Desligar_bomba" = BO de desligar (botoeira: pulso em cada uma)
--   comando "Valvula"        = solenoide da adutora, só no sistema conjugado (ON = fecha)
--   comando "Canhao"         = botão que alterna o canhão final (pulso)
--   status  "Bomba_ligada"   = confirmação da bomba (contator)
--   status  "Canhao_ligado"  = estado do canhão (sem ele o NexON não comanda o canhão)
--   status  "Permissivo"     = painel liberou a partida (bomba, tensão, pressão): espera antes de girar
-- "padrao": false = aparece no cadastro, mas vem desmarcado (cada pivô marca o que tem).
-- A sequência (PivoSequenciaService) acha os papéis pelo nome. Idempotente.
UPDATE tipos_equipamentos t
SET propriedades_schema = jsonb_set(t.propriedades_schema, '{pontos_nativos,comando}',
      COALESCE(t.propriedades_schema->'pontos_nativos'->'comando', '[]'::jsonb)
      || (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(
           '[{"id": "ligar_bomba", "label": "Ligar_bomba", "padrao": false},
             {"id": "desligar_bomba", "label": "Desligar_bomba", "padrao": false},
             {"id": "valvula", "label": "Valvula", "padrao": false},
             {"id": "canhao", "label": "Canhao", "padrao": false}]'::jsonb) x
          WHERE NOT COALESCE(t.propriedades_schema->'pontos_nativos'->'comando', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', x->>'id')))),
    updated_at = now()
WHERE t.codigo = 'PIVO'
  AND t.propriedades_schema ? 'pontos_nativos';

UPDATE tipos_equipamentos t
SET propriedades_schema = jsonb_set(t.propriedades_schema, '{pontos_nativos,status}',
      COALESCE(t.propriedades_schema->'pontos_nativos'->'status', '[]'::jsonb)
      || (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(
           '[{"id": "bomba_ligada", "label": "Bomba_ligada", "padrao": false},
             {"id": "canhao_ligado", "label": "Canhao_ligado", "padrao": false},
             {"id": "permissivo", "label": "Permissivo", "padrao": false}]'::jsonb) x
          WHERE NOT COALESCE(t.propriedades_schema->'pontos_nativos'->'status', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', x->>'id')))),
    updated_at = now()
WHERE t.codigo = 'PIVO'
  AND t.propriedades_schema ? 'pontos_nativos';

SELECT propriedades_schema->'pontos_nativos' FROM tipos_equipamentos WHERE codigo = 'PIVO';
