-- NEXON-5: parâmetros do pivô na aba Configuração do web (pressão mínima, lâmina e
-- tempo de volta a 100%, correção do ângulo zero) e direcionamento da água do sistema
-- conjugado (válvula pelo NexON / intertravamento físico, TON e BO da válvula).
-- Idempotente. ROLLBACK: ALTER TABLE pivo_config DROP COLUMN parametros;
ALTER TABLE pivo_config ADD COLUMN IF NOT EXISTS parametros jsonb;
