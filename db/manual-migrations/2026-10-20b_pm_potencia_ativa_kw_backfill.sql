-- PM (Pt em W, payload flat) sem potencia_ativa_kw: a ingestão não preenchia a coluna
-- para o formato flat, e o gráfico de demanda lê dela. Só preenche nulos; reverter =
-- voltar a NULL nos ids abaixo.
UPDATE equipamentos_dados
SET potencia_ativa_kw = round((dados->>'Pt')::numeric / 1000, 3)
WHERE equipamento_id IN ('af243646c520c41dd5fbc22e73', '4e5c29135388b0984d93396334')
  AND potencia_ativa_kw IS NULL
  AND dados ? 'Pt'
  AND jsonb_typeof(dados->'Pt') = 'number';
