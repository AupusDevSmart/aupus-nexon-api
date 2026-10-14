-- Parcial de 1 em 1 min da SSU (TON-V2): pulsos do último minuto, para a potência "agora"
-- e a curva minuto a minuto da ficha do medidor. NÃO entra em energia/demanda (essas vêm
-- dos blocos de fim de intervalo do medidor em equipamentos_dados). Retenção: 7 dias.
CREATE TABLE IF NOT EXISTS ssu_minutos (
  equipamento_id  char(26)   NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  ts              timestamp(0) NOT NULL,      -- UTC naive, hora de captura na TON
  nsu             integer,
  seg             integer,                   -- contagem regressiva do intervalo do medidor
  ke              numeric(12,8),             -- kWh/pulso usado
  phf integer NOT NULL DEFAULT 0, phr integer NOT NULL DEFAULT 0,
  qhfi integer NOT NULL DEFAULT 0, qhfc integer NOT NULL DEFAULT 0,
  qhri integer NOT NULL DEFAULT 0, qhrc integer NOT NULL DEFAULT 0,
  PRIMARY KEY (equipamento_id, ts)
);

-- Minuto do medidor (TON-V2, "fim":0/1): quadrante e posto do último segundo do minuto.
ALTER TABLE ssu_minutos ADD COLUMN IF NOT EXISTS q smallint;
ALTER TABLE ssu_minutos ADD COLUMN IF NOT EXISTS posto smallint;
