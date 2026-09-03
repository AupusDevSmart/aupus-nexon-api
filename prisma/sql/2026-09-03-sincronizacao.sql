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
