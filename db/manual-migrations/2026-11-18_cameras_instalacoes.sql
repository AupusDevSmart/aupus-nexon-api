-- NEXON-108 — Relato das instalações feitas pelo computador (instalar-pelo-pc.sh / .ps1).
-- O instalador manda o andamento (passo, estado, mensagem e o fim do registro) para a API; o administrador
-- vê em Configurações › Aparelhos das câmeras e investiga sem precisar de foto da tela. Uma linha por
-- sessão (o script gera o id). Idempotente. Rollback: DROP TABLE IF EXISTS cameras_instalacoes;
BEGIN;
CREATE TABLE IF NOT EXISTS cameras_instalacoes (
  id           varchar(26)  PRIMARY KEY,
  sessao       varchar(40)  NOT NULL UNIQUE,
  usuario_id   varchar(26),
  usuario_nome varchar(160),
  unidade_id   varchar(26),
  sistema      varchar(160),
  passo        varchar(120),
  estado       varchar(20)  NOT NULL DEFAULT 'andamento',
  mensagem     text,
  registro     text,
  ip           varchar(60),
  versao       varchar(40),
  created_at   timestamp(0) NOT NULL DEFAULT now(),
  updated_at   timestamp(0) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cameras_instalacoes_created_at_idx ON cameras_instalacoes (created_at DESC);
COMMIT;
