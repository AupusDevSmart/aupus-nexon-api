-- Sincronizacao entre AupusService e AupusNexOn
--
-- Os dois produtos tem bancos separados desde 2026-09, mas falam dos MESMOS
-- cadastros: usuario, planta, instalacao, equipamento. Hoje os bancos sao
-- clones (mesmos ids) e comecam a divergir agora.
--
-- TRES TABELAS, e o motivo de cada uma:
--
-- vinculos   — o portao. Nada atravessa a fronteira sem uma linha aqui, criada
--              por um humano. Sincronizacao automatica SEM esse portao faria um
--              cadastro novo vazar para o outro produto sem ninguem decidir.
--              Guarda tambem a VERSAO, e ai esta a decisao central:
--
--              o last-write-wins nao pode usar `updated_at`. Medido em dev, as
--              9 plantas tem `updated_at` NULL — os models `plantas` e
--              `usuarios` nao tem `@updatedAt`, entao o Prisma nunca preenche.
--              E as 4 tabelas sao `Timestamp(0)`, precisao de segundo: duas
--              edicoes no mesmo segundo dariam empate. Comparar relogio aqui e
--              comparar nulo com nulo.
--
--              Entao a versao e um contador proprio, monotonico por registro,
--              que so esta logica mexe. Empate de versao desempata pelo NOME DA
--              ORIGEM, que e igual nos dois lados — os dois nos chegam
--              sozinhos a mesma conclusao sobre quem venceu, sem se falar.
--
--              Vantagem de manutencao: as 4 tabelas compartilhadas nao mudam.
--
-- outbox     — a garantia de entrega. A linha e gravada NA MESMA TRANSACAO da
--              escrita do dado. Se o processo morrer entre salvar a planta e
--              avisar o outro lado, o evento ja esta commitado e o worker
--              entrega depois. Publicar por fora da transacao perde evento em
--              queda, calado.
--
-- auditoria  — sem isto ninguem responde "por que o NexOn tem essa planta" nem
--              "quem sobrescreveu minha edicao". Registra o que foi IGNORADO
--              por versao menor, que e o unico rastro de uma edicao perdida.
--
-- Ids em varchar SEMPRE TRIMADO. As 4 tabelas usam char(26), que devolve o id
-- com padding; guardar o padding aqui repetiria o bug de char/varchar que ja
-- custou 16 de 23 planos neste banco.
--
-- Idempotente: roda quantas vezes precisar, nos dois bancos.

CREATE TABLE IF NOT EXISTS sincronizacao_vinculos (
  id             BIGSERIAL     PRIMARY KEY,
  recurso        VARCHAR(30)   NOT NULL,
  registro_id    VARCHAR(26)   NOT NULL,
  versao         BIGINT        NOT NULL DEFAULT 0,
  origem         VARCHAR(20)   NOT NULL,
  hash_conteudo  VARCHAR(64),
  ativo          BOOLEAN       NOT NULL DEFAULT TRUE,
  vinculado_em   TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  vinculado_por  VARCHAR(26),
  atualizado_em  TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

-- Um vinculo por registro. E a chave que o upsert do receptor usa.
CREATE UNIQUE INDEX IF NOT EXISTS sincronizacao_vinculos_recurso_registro_key
  ON sincronizacao_vinculos (recurso, registro_id);

CREATE TABLE IF NOT EXISTS sincronizacao_outbox (
  id           BIGSERIAL     PRIMARY KEY,
  recurso      VARCHAR(30)   NOT NULL,
  registro_id  VARCHAR(26)   NOT NULL,
  operacao     VARCHAR(10)   NOT NULL,
  versao       BIGINT        NOT NULL,
  payload      JSONB         NOT NULL,
  criado_em    TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  tentativas   INT           NOT NULL DEFAULT 0,
  proxima_em   TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  entregue_em  TIMESTAMP(3),
  erro         TEXT
);

-- O worker so olha o que falta entregar. Indice PARCIAL: a fila entregue cresce
-- para sempre e nao deve pesar na busca do que esta pendente.
CREATE INDEX IF NOT EXISTS sincronizacao_outbox_pendentes_idx
  ON sincronizacao_outbox (proxima_em, id)
  WHERE entregue_em IS NULL;

CREATE TABLE IF NOT EXISTS sincronizacao_auditoria (
  id           BIGSERIAL     PRIMARY KEY,
  direcao      VARCHAR(10)   NOT NULL,
  recurso      VARCHAR(30)   NOT NULL,
  registro_id  VARCHAR(26)   NOT NULL,
  versao       BIGINT,
  origem       VARCHAR(20),
  resultado    VARCHAR(24)   NOT NULL,
  detalhe      TEXT,
  ator         VARCHAR(255),
  criado_em    TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sincronizacao_auditoria_registro_idx
  ON sincronizacao_auditoria (recurso, registro_id, criado_em DESC);

-- Conferencia:
--   SELECT recurso, count(*) FROM sincronizacao_vinculos WHERE ativo GROUP BY 1;
--   SELECT count(*) FROM sincronizacao_outbox WHERE entregue_em IS NULL;

-- ---------------------------------------------------------------------------
-- Captura: trigger, e nao intercepcao no ORM
--
-- O Prisma 6 removeu `$use` e o `$extends` devolve um cliente novo, que nao
-- encaixa num `PrismaService extends PrismaClient`. Mas o motivo de estar no
-- banco e melhor do que "o ORM nao deixou":
--
--   * pega TODA escrita — Prisma, `$executeRaw`, script de migracao, psql na
--     mao. Este projeto usa os quatro. Intercepcao no ORM deixaria de fora
--     justamente os caminhos mais usados aqui, e a falha seria silenciosa:
--     dado divergindo entre os dois produtos sem erro nenhum.
--   * "na mesma transacao" deixa de ser promessa do codigo e passa a ser
--     inerente. Nao ha janela entre gravar a planta e gravar o evento.
--
-- O trigger e de proposito BURRO: anota que o registro mudou e a versao nova.
-- Nao monta o payload. Quem monta e o worker, em TypeScript, na hora de enviar:
--
--   * a lista do que nunca viaja (senha, remember_token, role) fica em UM lugar
--     so. Repetida aqui em PL/pgSQL, um dia as duas divergiriam — e a que
--     vazaria credencial seria esta.
--   * o envio leva o estado ATUAL. Cinco edicoes seguidas viram cinco eventos
--     que convergem para o mesmo conteudo, em vez de cinco fotos velhas.
-- ---------------------------------------------------------------------------

-- Quem e este no. Entra em todo evento e desempata conflito de versao.
CREATE TABLE IF NOT EXISTS sincronizacao_no (
  travar  BOOLEAN     PRIMARY KEY DEFAULT TRUE,
  origem  VARCHAR(20) NOT NULL,
  CONSTRAINT sincronizacao_no_linha_unica CHECK (travar)
);

-- `SET search_path = public` como ATRIBUTO da funcao, nao no script.
--
-- O corpo resolve os nomes na hora em que o trigger dispara, com o search_path
-- de quem escreveu — nao com o de quem criou a funcao. E o banco de producao
-- tem um schema `bdo` (do bdo-aupus-api) com tabelas chamadas `usuarios` e
-- `unidades`, os MESMOS nomes que este trigger observa.
--
-- Hoje o Prisma conecta com `?schema=public` e nada quebraria. Mas basta um
-- `ALTER DATABASE ... SET search_path`, ou uma conexao de manutencao aberta com
-- outro path, para o trigger passar a olhar a tabela errada — e o sintoma seria
-- evento de sincronizacao com dado de outro sistema, nao um erro.
CREATE OR REPLACE FUNCTION public.sincronizacao_capturar() RETURNS TRIGGER AS $$
DECLARE
  v_id      TEXT;
  v_versao  BIGINT;
  v_origem  VARCHAR(20);
  v_op      VARCHAR(10);
BEGIN
  -- A escrita que veio do outro produto NAO gera evento de volta. Sem isto os
  -- dois lados ficam se empurrando o mesmo registro para sempre — dois sistemas
  -- em laco infinito porque concordam.
  IF coalesce(current_setting('sincronizacao.replicando', TRUE), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_id := btrim((COALESCE(NEW, OLD)).id);

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

  -- So o que esta vinculado atravessa. E o portao: sem ele, cadastro novo
  -- vazaria para o outro produto sem ninguem ter decidido.
  UPDATE sincronizacao_vinculos
     SET versao = versao + 1, origem = v_origem, atualizado_em = NOW()
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

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios','plantas','unidades','equipamentos'] LOOP
    -- `public.%I` explicito pelo mesmo motivo: sem o schema, QUAL `usuarios`
    -- recebe o trigger depende do search_path de quem roda este arquivo.
    EXECUTE format('DROP TRIGGER IF EXISTS sincronizacao_captura ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER sincronizacao_captura
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.sincronizacao_capturar(%L)', t, t);
  END LOOP;
END $$;

-- Conferencia:
--   SELECT origem FROM sincronizacao_no;
--   SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname='sincronizacao_captura';
