-- ============================================================================
-- AUPU-70 (apps NexON v2) — convite de operador + permissão por instalação.
--
-- usuario_convites: POST /usuarios/convites cria o operador com status
--   'Inativo' e senha aleatória inutilizável; o link leva ao fluxo de redefinição
--   de senha que já existe (/redefinir-senha?token=&email=). Redefinir com o token
--   do convite ativa o usuário (status 'Ativo') e marca aceito_em. Só o hash
--   (bcrypt) do token fica aqui.
--
-- usuario_unidade_permissoes: o que o operador pode em cada instalação. Visualizar
--   é implícito (a linha existir). Usuário SEM nenhuma linha = modelo antigo (vale
--   só a permission do papel). Usuário COM linhas: comandar exige a linha da
--   unidade do equipamento com comandar=true, senão 403 SEM_PERMISSAO_UNIDADE.
--
-- Idempotente. ROLLBACK:
--   DROP TABLE IF EXISTS usuario_convites; DROP TABLE IF EXISTS usuario_unidade_permissoes;
-- ============================================================================

CREATE TABLE IF NOT EXISTS usuario_convites (
  id            char(26)     PRIMARY KEY,
  usuario_id    char(26)     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_por    char(26),
  token_hash    varchar(255) NOT NULL,
  canais        text[]       NOT NULL DEFAULT '{}',    -- 'email' | 'whatsapp'
  validade_dias integer      NOT NULL DEFAULT 7,
  enviado_em    timestamp    NOT NULL DEFAULT now(),
  expira_em     timestamp    NOT NULL,
  aceito_em     timestamp,
  cancelado_em  timestamp,
  reenvios      integer      NOT NULL DEFAULT 0,
  created_at    timestamp    NOT NULL DEFAULT now(),
  updated_at    timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usuario_convites_usuario_idx
  ON usuario_convites (usuario_id)
  WHERE aceito_em IS NULL AND cancelado_em IS NULL;

CREATE TABLE IF NOT EXISTS usuario_unidade_permissoes (
  usuario_id  char(26)   NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  unidade_id  char(26)   NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  comandar    boolean    NOT NULL DEFAULT false,
  relatorios  boolean    NOT NULL DEFAULT false,
  updated_by  char(26),
  created_at  timestamp  NOT NULL DEFAULT now(),
  updated_at  timestamp  NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, unidade_id)
);

CREATE INDEX IF NOT EXISTS usuario_unidade_permissoes_unidade_idx
  ON usuario_unidade_permissoes (unidade_id);
