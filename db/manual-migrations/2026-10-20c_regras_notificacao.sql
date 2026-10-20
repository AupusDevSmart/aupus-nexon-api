-- NEXON-25 — Regras de notificação (Configurações › Notificações).
-- Quem é avisado, de quê e por qual canal. Só as regras: o disparo dos avisos é fase 2
-- e os avisos que acontecem seguem em "Alarmes e Eventos". Idempotente.
-- Quem recebe = usuários com algum papel de `papeis` (limitados às plantas da regra)
--               + usuários de `usuario_ids`. `planta_ids` vazio = todas as plantas.
-- Rollback:
--   DROP TABLE IF EXISTS regras_notificacao;
BEGIN;

CREATE TABLE IF NOT EXISTS regras_notificacao (
  id                  char(26) PRIMARY KEY,
  nome                varchar(100) NOT NULL,
  evento              varchar(40) NOT NULL
                      CHECK (evento IN ('falha', 'sem_comunicacao', 'vencimento_acesso_morador')),
  limite_minutos      integer CHECK (limite_minutos IS NULL OR limite_minutos > 0),   -- sem_comunicacao (padrão 30)
  antecedencia_dias   integer CHECK (antecedencia_dias IS NULL OR antecedencia_dias >= 0), -- vencimento (padrão 7)
  canais              text[] NOT NULL DEFAULT '{}',   -- push | email | whatsapp
  papeis              text[] NOT NULL DEFAULT '{}',
  planta_ids          text[] NOT NULL DEFAULT '{}',
  usuario_ids         text[] NOT NULL DEFAULT '{}',
  ativo               boolean NOT NULL DEFAULT true,
  created_by          char(26),
  updated_by          char(26),
  created_at          timestamp(0) NOT NULL DEFAULT now(),
  updated_at          timestamp(0) NOT NULL DEFAULT now(),
  deleted_at          timestamp(0)
);

CREATE INDEX IF NOT EXISTS regras_notificacao_evento_idx ON regras_notificacao (evento);
CREATE INDEX IF NOT EXISTS regras_notificacao_planta_ids_idx ON regras_notificacao USING gin (planta_ids);

COMMIT;
