-- ============================================================================
-- AUPU-70 (apps NexON v2) — sessões de login (Conta e segurança → Sessões).
--
-- Cada login cria uma sessão. O refresh token carrega `sid` (id da sessão) +
-- `jti` (aleatório); aqui fica só o sha256 do jti atual. Cada refresh ROTACIONA
-- o jti. O jti anterior ainda vale por 60 s (duas telas pedindo refresh ao mesmo
-- tempo não derrubam a sessão); fora disso, refresh com jti velho → 401 (a
-- sessão continua; só aquele token morreu).
--
-- Sessão revogada: o refresh passa a dar 401. O access token já emitido (1 h)
-- continua valendo até expirar — aceito (não há checagem por request).
--
-- Tokens SEM sid (emitidos antes deste deploy, web legado) continuam válidos; no
-- primeiro refresh ganham uma sessão.
--
-- Idempotente. ROLLBACK: DROP TABLE IF EXISTS auth_sessoes;
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth_sessoes (
  id                         char(26)     PRIMARY KEY,
  usuario_id                 char(26)     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  refresh_jti_hash           varchar(64)  NOT NULL,
  refresh_jti_anterior_hash  varchar(64),
  rotacionado_em             timestamp,
  dispositivo                varchar(120),            -- "iPhone 15 Pro · iOS" / "Chrome no Windows"
  plataforma                 varchar(40),             -- iOS | Android | Web
  user_agent                 varchar(255),
  ip                         varchar(64),
  cidade                     varchar(120),            -- sem geo-IP por enquanto: fica NULL
  created_at                 timestamp    NOT NULL DEFAULT now(),
  last_used_at               timestamp    NOT NULL DEFAULT now(),
  expira_em                  timestamp    NOT NULL,
  revoked_at                 timestamp
);

CREATE INDEX IF NOT EXISTS auth_sessoes_usuario_idx
  ON auth_sessoes (usuario_id, last_used_at DESC)
  WHERE revoked_at IS NULL;
