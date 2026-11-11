\set ON_ERROR_STOP on

-- Calibração do ângulo do pivô (NEXON-103).
--
-- O encoder entrega uma contagem bruta, que não é o azimute. Cada linha associa UMA leitura do
-- encoder (bruto_cal) ao azimute real do braço medido em campo (az_cal, do centro até a ponta,
-- 0° = norte verdadeiro, horário). Uma linha por calibração; a vigente é a única com ativa = true.
-- Salvar desativa a anterior (nunca apaga) — "Restaurar calibração anterior" reativa a última inativa.
--
--   bruto_cal, sentido (+1 horário / −1 anti-horário), centro e ponta (graus decimais), az_cal:
--       os campos da spec. O ângulo em operação é (az_cal + sentido·(bruto − bruto_cal)·360/resolucao) mod 360.
--   resolucao, encoder_equipamento_id: o encoder em que a calibração foi feita (trocar o encoder
--       ou a resolução na Configuração desativa a calibração).
--   zero: a mesma calibração no formato que a TON guarda (`pivo enc <resolução> <inv> <zero>`).
--   leituras: as 5 leituras seguidas do "Ler encoder" que valeram.
--   origem: 'calibracao' (salva na tela) ou 'restauracao' (reativada pelo botão).
--
-- Aplicar ANTES de publicar o código. Sem a tabela a API responde "calibração indisponível" e o
-- pivô com encoder fica como "sem calibração" (só o valor bruto).
-- Idempotente. ROLLBACK: DROP TABLE IF EXISTS public.calibracao_angulo;

BEGIN;

CREATE TABLE IF NOT EXISTS public.calibracao_angulo (
  id                      char(26) PRIMARY KEY,
  equipamento_id          char(26) NOT NULL REFERENCES public.equipamentos(id) ON DELETE CASCADE,
  bruto_cal               integer NOT NULL,
  sentido                 smallint NOT NULL,
  centro_lat              numeric(10,7) NOT NULL,
  centro_lon              numeric(10,7) NOT NULL,
  ponta_lat               numeric(10,7) NOT NULL,
  ponta_lon               numeric(10,7) NOT NULL,
  az_cal                  numeric(5,2) NOT NULL,
  resolucao               integer NOT NULL,
  zero                    numeric(6,2) NOT NULL,
  encoder_equipamento_id  char(26),
  leituras                jsonb,
  origem                  text NOT NULL DEFAULT 'calibracao',
  usuario_id              char(26),
  criado_em               timestamp NOT NULL DEFAULT now(),
  ativa                   boolean NOT NULL DEFAULT true,
  desativada_em           timestamp,
  desativada_por          char(26),
  motivo_desativacao      text,
  CONSTRAINT calibracao_angulo_sentido_chk CHECK (sentido IN (1, -1)),
  CONSTRAINT calibracao_angulo_bruto_chk CHECK (bruto_cal >= 0),
  CONSTRAINT calibracao_angulo_az_chk CHECK (az_cal >= 0 AND az_cal < 360),
  CONSTRAINT calibracao_angulo_resolucao_chk CHECK (resolucao >= 16),
  CONSTRAINT calibracao_angulo_coord_chk CHECK (
    centro_lat BETWEEN -90 AND 90 AND ponta_lat BETWEEN -90 AND 90
    AND centro_lon BETWEEN -180 AND 180 AND ponta_lon BETWEEN -180 AND 180)
);

-- Uma calibração vigente por pivô.
CREATE UNIQUE INDEX IF NOT EXISTS calibracao_angulo_ativa_uq
  ON public.calibracao_angulo (equipamento_id) WHERE ativa;
-- Histórico do pivô, da mais nova para a mais antiga.
CREATE INDEX IF NOT EXISTS calibracao_angulo_equip_idx
  ON public.calibracao_angulo (equipamento_id, criado_em DESC);

COMMENT ON TABLE public.calibracao_angulo IS 'Calibração do ângulo do pivô (NEXON-103): leitura do encoder × azimute medido em campo. Uma linha por calibração; vigente = ativa.';
COMMENT ON COLUMN public.calibracao_angulo.sentido IS '+1: a contagem do encoder aumenta com o pivô no sentido horário (visto de cima); −1: diminui.';
COMMENT ON COLUMN public.calibracao_angulo.az_cal IS 'Azimute do braço na calibração (centro → ponta), 0° = norte verdadeiro, horário.';
COMMENT ON COLUMN public.calibracao_angulo.zero IS 'A calibração no formato da TON: zero = az_cal − sentido·bruto_cal·360/resolucao (−180 a 180).';

COMMIT;
