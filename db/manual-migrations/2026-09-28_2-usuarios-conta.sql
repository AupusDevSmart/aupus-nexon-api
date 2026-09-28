-- ============================================================================
-- AUPU-70 (apps NexON v2) — conta do usuário: senha, janela de comando,
-- preferências de notificação e tokens de push.
--
-- usuarios.senha_alterada_em  carimbado em change-password, reset-password
--                             (admin) e redefinição por token/convite. Exposto
--                             em GET /auth/me ("Alterada em 12/03/2024").
-- usuarios.cmd_janela         {inicio:'06:00', fim:'18:00', dias:[1..7]} | NULL.
--                             Fora da janela o acionar devolve 403
--                             COMANDO_FORA_JANELA. NULL = sem restrição.
--
-- As duas colunas ficam FORA do schema Prisma DE PROPÓSITO: a sincronização
-- Service <-> NexOn replica `usuarios` pelo DMMF (lista de negação em
-- sincronizacao/recursos.ts) — coluna modelada viajaria para um banco que não a tem.
--
-- Idempotente. ROLLBACK:
--   ALTER TABLE usuarios DROP COLUMN IF EXISTS senha_alterada_em, DROP COLUMN IF EXISTS cmd_janela;
--   DROP TABLE IF EXISTS usuario_notificacoes; DROP TABLE IF EXISTS dispositivos_push;
-- ============================================================================

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_alterada_em timestamp;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cmd_janela        jsonb;

CREATE TABLE IF NOT EXISTS usuario_notificacoes (
  usuario_id        char(26)   PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  alarmes_criticos  boolean    NOT NULL DEFAULT true,
  alarmes_atencao   boolean    NOT NULL DEFAULT true,
  comandos          boolean    NOT NULL DEFAULT false,
  resumo_diario     boolean    NOT NULL DEFAULT false,
  updated_at        timestamp  NOT NULL DEFAULT now()
);

-- Token de push (APNs no iOS; FCM no Android quando houver Firebase).
-- O envio ainda NÃO existe (sem credenciais) — ver NotificacoesPushService.
CREATE TABLE IF NOT EXISTS dispositivos_push (
  id          char(26)     PRIMARY KEY,
  usuario_id  char(26)     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  plataforma  varchar(16)  NOT NULL,
  token       varchar(512) NOT NULL,
  created_at  timestamp    NOT NULL DEFAULT now(),
  updated_at  timestamp    NOT NULL DEFAULT now(),
  CONSTRAINT dispositivos_push_plataforma_chk CHECK (plataforma IN ('ios', 'android', 'web'))
);

-- Um token pertence a um aparelho; se outro usuário logar no mesmo aparelho, o
-- token muda de dono (upsert pelo token).
CREATE UNIQUE INDEX IF NOT EXISTS dispositivos_push_token_uniq ON dispositivos_push (token);
CREATE INDEX IF NOT EXISTS dispositivos_push_usuario_idx ON dispositivos_push (usuario_id);
