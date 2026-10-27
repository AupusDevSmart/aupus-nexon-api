-- Soft-starter no unifilar: elemento de manobra/partida de motor (pivôs, bombas) que hoje
-- aparece desenhado como DJ. Mesmo papel do disjuntor na supervisão: medição pelo PM/IED
-- vinculado (Topologia → Vínculos), status e comando — só que Partir/Parar e Ligado/Desligado/Falha.
-- Trocar um DJ existente por soft-starter = editar o equipamento e mudar o tipo (mantém id,
-- posição, conexões, vínculos e rótulos).
BEGIN;
INSERT INTO categorias_equipamentos (id, nome)
VALUES ('catsoftstarter000000000000', 'Soft-Starter')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tipos_equipamentos (id, codigo, nome, sigla, categoria_id, fabricante, largura_padrao, altura_padrao,
                                disp_unifilar, disp_iot, propriedades_schema, created_at, updated_at)
VALUES ('tiposoftstarter00000000000', 'SOFTSTARTER', 'Soft-Starter', 'SS', 'catsoftstarter000000000000', 'Genérico',
        32, 24, true, false,
        '{"campos": [
            {"tipo": "number", "campo": "Tensão Nominal", "unidade": "V", "obrigatorio": false},
            {"tipo": "number", "campo": "Corrente Nominal", "unidade": "A", "obrigatorio": false},
            {"tipo": "number", "campo": "Potência do Motor", "unidade": "kW", "obrigatorio": false}
          ],
          "pontos_nativos": {
            "comando": [{"id": "partir", "label": "Partir"}, {"id": "parar", "label": "Parar"}],
            "status": [{"id": "ligado", "label": "Ligado"}, {"id": "desligado", "label": "Desligado"},
                       {"id": "falha", "label": "Falha"}, {"id": "local", "label": "Local"}, {"id": "remoto", "label": "Remoto"}],
            "medicao_perfis": ["pm", "ied"]
          }}'::jsonb,
        now(), now())
ON CONFLICT (codigo) DO NOTHING;
COMMIT;

-- ROLLBACK (só se nenhum equipamento usar o tipo):
-- DELETE FROM tipos_equipamentos WHERE id = 'tiposoftstarter00000000000';
-- DELETE FROM categorias_equipamentos WHERE id = 'catsoftstarter000000000000';
