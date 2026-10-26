-- Acompanhamento de cada OTA até a confirmação: a tela só dizia "comando publicado".
-- Estados: publicado → baixando (progresso %) → reiniciando → confirmado (TON voltou anunciando a
-- versão nova) | falhou (erro da TON / voltou com outra versão = rollback) | sem_resposta (timeout).
CREATE TABLE IF NOT EXISTS ota_execucoes (
  id               char(26)     PRIMARY KEY,
  equipamento_id   char(26)     NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  topico           varchar(255) NOT NULL,
  versao_firmware  varchar(64),            -- FIRMWARE_VERSION embutida no binário (o que a TON anuncia)
  versao_comando   varchar(64),            -- version enviada no comando OTA
  versao_anterior  varchar(64),            -- o que a TON anunciava antes
  url              text,
  md5              varchar(64),
  tamanho          integer,
  estado           varchar(20)  NOT NULL DEFAULT 'publicado',
  progresso        integer      NOT NULL DEFAULT 0,
  detalhe          text,
  criado_em        timestamp    NOT NULL DEFAULT now(),
  atualizado_em    timestamp    NOT NULL DEFAULT now(),
  concluido_em     timestamp
);
CREATE INDEX IF NOT EXISTS idx_ota_execucoes_eq ON ota_execucoes (equipamento_id, criado_em DESC);
