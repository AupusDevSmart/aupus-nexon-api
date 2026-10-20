/** NEXON-25 — vocabulário das regras de notificação (API e tela usam os mesmos valores). */
export const EVENTOS_NOTIFICACAO = ['falha', 'sem_comunicacao', 'vencimento_acesso_morador'] as const;
export const CANAIS_NOTIFICACAO = ['push', 'email', 'whatsapp'] as const;
/** Papéis canônicos da spec de permissões (NEXON-20, ADR 0002; ver auth/papeis.ts). */
export const PAPEIS_NOTIFICACAO = ['admin', 'analista_automacao', 'analista_operacao', 'proprietario', 'operador'] as const;

export type EventoNotificacao = (typeof EVENTOS_NOTIFICACAO)[number];
export type CanalNotificacao = (typeof CANAIS_NOTIFICACAO)[number];

export const ROTULO_EVENTO: Record<EventoNotificacao, string> = {
  falha: 'Falha',
  sem_comunicacao: 'Sem comunicação',
  vencimento_acesso_morador: 'Vencimento de acesso de morador',
};

export const ROTULO_CANAL: Record<CanalNotificacao, string> = {
  push: 'Push no app',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
};

/** Padrões quando a regra não informa o parâmetro do evento. */
export const LIMITE_MINUTOS_PADRAO = 30;
export const ANTECEDENCIA_DIAS_PADRAO = 7;
