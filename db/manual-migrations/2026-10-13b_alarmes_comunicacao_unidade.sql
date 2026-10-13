-- Unidades fora do monitoramento de comunicação (sistema retirado / monitorada por API de nuvem).
-- Unidade com status 'inativo' também é ignorada, sem precisar estar aqui.
CREATE TABLE IF NOT EXISTS alarme_comunicacao_unidade (
  unidade_id   char(25)     PRIMARY KEY REFERENCES unidades(id) ON DELETE CASCADE,
  motivo       varchar(20)  NOT NULL CHECK (motivo IN ('retirado', 'api', 'outro')),
  observacao   text,
  definido_por char(25),
  created_at   timestamp    NOT NULL DEFAULT now()
);

-- Resumo de comunicação como seção final do boletim das 21:05 (só a mensagem do GRUPO).
-- Nasce DESLIGADO: liga só depois de conferir o preview.
ALTER TABLE alarme_comunicacao_config ADD COLUMN IF NOT EXISTS incluir_no_boletim boolean NOT NULL DEFAULT false;
