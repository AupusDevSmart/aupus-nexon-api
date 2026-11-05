-- Cadastro de planta e instalacao sem campos obrigatorios (alem do nome).
--
-- Pedido do usuario (05/nov/2026): no AupusService muitas vezes a planta e
-- cadastrada sem CNPJ, CEP, endereco ou proprietario, e a instalacao sem
-- coordenadas, potencia ou tipo. A obrigatoriedade volta aos poucos, campo a
-- campo, quando o dado existir.
--
-- Por que o NexOn tambem muda: plantas e unidades sao sincronizadas entre os
-- dois bancos (2026-09-03-sincronizacao.sql), e o registro vinculado viaja com
-- TODAS as colunas. Se o Service grava NULL e aqui a coluna e NOT NULL, a
-- entrega do outbox falha e trava a fila daquele registro.
--
-- Ficam obrigatorios: plantas.nome, unidades.nome, unidades.planta_id.
--
-- plantas.cnpj continua UNIQUE: no Postgres o indice unico aceita varios NULL,
-- entao planta sem CNPJ nao colide. O codigo converte vazio em NULL antes de
-- gravar (dois "" colidiriam).
--
-- plantas.proprietario_id continua com a FK para usuarios; NULL so significa
-- "sem proprietario".
--
-- ORDEM DO DEPLOY: este SQL no banco do NexOn (aupus) E o de mesmo nome do
-- aupus-service-api no aupus_service, depois as DUAS APIs. Com so um lado novo,
-- a planta vinculada salva sem CNPJ/CEP/dono e recusada pelo client antigo do
-- outro lado e a entrega fica em erro ate o outro lado subir.
--
-- Idempotente: DROP NOT NULL numa coluna que ja aceita nulo nao faz nada.
-- Nenhum dado e alterado. Para voltar a exigir um campo, primeiro preencher os
-- nulos e depois SET NOT NULL naquela coluna.

ALTER TABLE "plantas"
  ALTER COLUMN "cnpj" DROP NOT NULL,
  ALTER COLUMN "cep" DROP NOT NULL,
  ALTER COLUMN "cidade" DROP NOT NULL,
  ALTER COLUMN "uf" DROP NOT NULL,
  ALTER COLUMN "logradouro" DROP NOT NULL,
  ALTER COLUMN "horario_funcionamento" DROP NOT NULL,
  ALTER COLUMN "localizacao" DROP NOT NULL,
  ALTER COLUMN "proprietario_id" DROP NOT NULL;

ALTER TABLE "unidades"
  ALTER COLUMN "cidade" DROP NOT NULL,
  ALTER COLUMN "estado" DROP NOT NULL,
  ALTER COLUMN "latitude" DROP NOT NULL,
  ALTER COLUMN "longitude" DROP NOT NULL,
  ALTER COLUMN "potencia" DROP NOT NULL,
  ALTER COLUMN "tipo" DROP NOT NULL;
