-- Equipamento "Carga" no unifilar — só VISUAL (sem MQTT/leitura/comando, sem pontos nativos).
-- Ícone: CargaIcon (indutor + resistor em caixa, seta de saída), mapeado pela categoria 'Carga'.
BEGIN;
INSERT INTO categorias_equipamentos (id, nome)
VALUES ('catcarga000000000000000000', 'Carga')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tipos_equipamentos
  (id, codigo, nome, largura_padrao, altura_padrao, propriedades_schema, updated_at,
   categoria_id, fabricante, disp_unifilar, disp_iot, sigla)
VALUES
  ('tipocarga00000000000000000', 'CARGA', 'Carga', 48, 48,
   '{"somente_visual": true, "campos": [{"tipo": "number", "campo": "Potência", "unidade": "kW", "obrigatorio": false}]}'::jsonb,
   now(), 'catcarga000000000000000000', 'Genérico', true, false, 'CRG')
ON CONFLICT (codigo) DO NOTHING;
COMMIT;
