-- NEXON-28 — Resumo diário de equipamentos_dados para os gráficos de mês e ano.
-- Uma linha por equipamento × dia local (America/Sao_Paulo) fechado; ontem e hoje
-- são calculados na hora e nunca entram aqui. num_leituras = 0 marca dia já
-- calculado sem leitura. A varredura de 5 em 5 min (AgregadoDiarioService) apaga
-- o dia que recebe leitura atrasada, a partir de equipamentos_dados_dia_marca.
-- Pode ser apagada a qualquer hora: tudo se recalcula sob demanda. Idempotente.
-- Rollback:
--   DROP TABLE IF EXISTS equipamentos_dados_dia, equipamentos_dados_dia_marca;
BEGIN;

CREATE TABLE IF NOT EXISTS equipamentos_dados_dia (
  equipamento_id    char(26) NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  dia               date NOT NULL,
  energia_kwh       double precision,
  potencia_media_kw double precision,
  num_leituras      integer NOT NULL,
  calculado_em      timestamp(0) NOT NULL DEFAULT now(),
  PRIMARY KEY (equipamento_id, dia)
);

CREATE TABLE IF NOT EXISTS equipamentos_dados_dia_marca (
  id  smallint PRIMARY KEY CHECK (id = 1),
  ate timestamp(0) NOT NULL
);
INSERT INTO equipamentos_dados_dia_marca (id, ate) VALUES (1, now()) ON CONFLICT DO NOTHING;

COMMIT;
