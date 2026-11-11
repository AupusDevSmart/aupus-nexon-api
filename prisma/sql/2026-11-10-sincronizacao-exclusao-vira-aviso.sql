\set ON_ERROR_STOP on

-- Sincronizacao: exclusao nao atravessa sozinha, e apagar desliga o vinculo
--
-- O incidente (26/10 a 07/11/2026): um super admin apagou no Service 15
-- registros compartilhados sem desvincular; a fila aplicou as exclusoes no
-- NexON 12 dias depois e escondeu usinas com TON ativa. Desde 09/11 o receptor
-- nao aplica exclusao recebida (39e882f / 8729cf2). Este arquivo fecha o resto:
--
-- 1. sincronizacao_exclusoes_pendentes — o AVISO. A exclusao feita do outro
--    lado chega como aviso: "Apagado no Service em <data>" (e o mesmo no sentido contrario). Alguem decide aqui
--    (apagar tambem / manter so aqui), e a decisao fica registrada. Uma linha
--    pendente por registro (indice unico parcial): o mesmo aviso repetido pela
--    fila nao duplica.
--
-- 2. sincronizacao_capturar() — apagar um registro compartilhado DESLIGA o
--    vinculo dele, na mesma transacao, alem de enfileirar o aviso. Sem isto, o
--    registro restaurado aqui voltaria a mandar edicoes, e o outro lado (que
--    desligou o vinculo ao receber o aviso) as ignoraria sem ninguem saber por
--    que. Restaurar nao religa: religar e o compartilhar da tela.
--
-- 3. Restaurar (deleted_at de volta a nulo) com o vinculo desligado enfileira um
--    'restauro': o outro lado fecha o aviso, que dizia "apagado la" de um
--    registro vivo (decidir "apagar" em cima dele apagaria la o que voltou aqui).
--    So o aviso se fecha; o vinculo segue desligado dos dois lados. Vale tambem
--    para o SQL manual com replicando='on' (o jeito da casa de restaurar).
--
-- Idempotente. So nos bancos do NexON (o Service tem o arquivo dele, igual). No
-- banco aupus de producao ha tabelas de outros sistemas (iot_*, schema bdo):
-- este arquivo so cria uma tabela nova e troca a funcao do trigger.
-- Nada nas 4 tabelas compartilhadas muda; nenhuma linha existente e alterada.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Dentro da transacao e com ON_ERROR_STOP: num `psql -f` no banco errado, o RAISE para
-- o arquivo inteiro (fora dela, ou sem o ON_ERROR_STOP, o psql seguia e criava a tabela)
DO $$
BEGIN
  IF current_database() NOT IN ('aupus', 'aupus_nexon') THEN
    RAISE EXCEPTION 'Este SQL e do banco do NexON (aupus/aupus_nexon), nao de %', current_database();
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.sincronizacao_exclusoes_pendentes (
  id            BIGSERIAL     PRIMARY KEY,
  recurso       VARCHAR(30)   NOT NULL,
  registro_id   VARCHAR(26)   NOT NULL,
  -- O produto onde foi apagado e quando (o evento leva a hora da exclusao; o
  -- de antes desta versao nao levava, e fica so o recebido_em)
  origem        VARCHAR(20)   NOT NULL,
  apagado_em    TIMESTAMP(3),
  apagado_por   VARCHAR(255),
  recebido_em   TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  -- 'apagar' (apagou aqui tambem), 'manter' (fica so aqui) ou 'restaurado' (voltou
  -- la, e o aviso se fechou sozinho); nulo = pendente
  decisao       VARCHAR(10),
  decidido_em   TIMESTAMP(3),
  decidido_por  VARCHAR(26),
  CONSTRAINT sincronizacao_exclusoes_decisao_valida CHECK (decisao IS NULL OR decisao IN ('apagar', 'manter', 'restaurado'))
);

-- A tabela de quem rodou a primeira versao deste arquivo (so o dev) tem o CHECK sem o 'restaurado'
ALTER TABLE public.sincronizacao_exclusoes_pendentes DROP CONSTRAINT IF EXISTS sincronizacao_exclusoes_decisao_valida;
ALTER TABLE public.sincronizacao_exclusoes_pendentes
  ADD CONSTRAINT sincronizacao_exclusoes_decisao_valida CHECK (decisao IS NULL OR decisao IN ('apagar', 'manter', 'restaurado'));

CREATE UNIQUE INDEX IF NOT EXISTS sincronizacao_exclusoes_uma_pendente
  ON public.sincronizacao_exclusoes_pendentes (recurso, registro_id)
  WHERE decisao IS NULL;

CREATE OR REPLACE FUNCTION public.sincronizacao_capturar() RETURNS TRIGGER AS $$
DECLARE
  v_id      TEXT;
  v_versao  BIGINT;
  v_origem  VARCHAR(20);
  v_op      VARCHAR(10);
BEGIN
  v_id := btrim((COALESCE(NEW, OLD)).id);

  -- Restaurado (deleted_at de volta a nulo) com o vinculo desligado (a exclusao o
  -- desligou): o outro lado fecha o aviso. O vinculo continua desligado; com ele
  -- ligado, segue o upsert de sempre. ANTES do portao da replicacao: o SQL manual de
  -- restauracao roda com replicando='on', e o aviso de la seguiria dizendo "apagado".
  -- Sem laco: a replicacao nunca grava deleted_at, e o restauro la so fecha o aviso.
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    SELECT origem INTO v_origem FROM sincronizacao_no LIMIT 1;
    UPDATE sincronizacao_vinculos
       SET versao = versao + 1, origem = COALESCE(v_origem, origem), atualizado_em = NOW()
     WHERE recurso = TG_ARGV[0] AND registro_id = v_id AND NOT ativo
    RETURNING versao INTO v_versao;
    IF v_versao IS NOT NULL THEN
      INSERT INTO sincronizacao_outbox (recurso, registro_id, operacao, versao, payload)
      VALUES (TG_ARGV[0], v_id, 'restauro', v_versao, '{}'::jsonb);
      RETURN NEW;
    END IF;
  END IF;

  -- A escrita que veio do outro produto NAO gera evento de volta (o laco).
  IF coalesce(current_setting('sincronizacao.replicando', TRUE), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Delete de verdade e soft delete contam como remocao para o outro lado.
  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
  ELSIF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    v_op := 'delete';
  ELSE
    v_op := 'upsert';
  END IF;

  SELECT origem INTO v_origem FROM sincronizacao_no LIMIT 1;
  IF v_origem IS NULL THEN
    RAISE EXCEPTION 'sincronizacao_no vazia: este servidor nao sabe o proprio nome';
  END IF;

  -- So o que esta vinculado atravessa (o portao). Apagado aqui, o vinculo se
  -- desliga junto (10/11/2026): o outro lado recebe um AVISO, e restaurar aqui
  -- nao volta a mandar edicoes que la seriam ignoradas.
  UPDATE sincronizacao_vinculos
     SET versao = versao + 1, origem = v_origem, atualizado_em = NOW(),
         ativo = (v_op <> 'delete')
   WHERE recurso = TG_ARGV[0] AND registro_id = v_id AND ativo
  RETURNING versao INTO v_versao;

  IF v_versao IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO sincronizacao_outbox (recurso, registro_id, operacao, versao, payload)
  VALUES (TG_ARGV[0], v_id, v_op, v_versao, '{}'::jsonb);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMIT;

-- Conferencia:
--   SELECT to_regclass('public.sincronizacao_exclusoes_pendentes');           -- nao nulo
--   SELECT prosrc LIKE '%v_op <> ''delete''%' AND prosrc LIKE '%''restauro''%' FROM pg_proc WHERE proname = 'sincronizacao_capturar';  -- true
--   SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname = 'sincronizacao_captura';         -- 4 tabelas
