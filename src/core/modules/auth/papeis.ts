/**
 * Papéis do NexON e o que cada um pode (spec "NexON — Permissões e controle de
 * acesso", NEXON-20). Lógica PURA, testada em papeis.spec.ts.
 *
 * Permissão = papel (o que pode fazer) × escopo (onde pode fazer). O escopo
 * (plantas / equipamentos liberados) fica no PermissionScopeService; aqui só o
 * que depende do papel.
 *
 * Nomes no banco (tabela `roles`) → papel canônico:
 *  - super_admin, admin                    → admin
 *  - analista_automacao, analista (legado) → analista_automacao
 *  - analista_operacao, gerente (legado)   → analista_operacao
 *  - proprietario, propietario (typo)      → proprietario
 *  - operador                              → operador
 *  - qualquer outro (cativo, associado...) → outro (sem nada; escopo por vínculo)
 */
export type Papel =
  | 'admin'
  | 'analista_automacao'
  | 'analista_operacao'
  | 'proprietario'
  | 'operador'
  | 'outro';

export const PAPEIS: readonly Papel[] = [
  'admin',
  'analista_automacao',
  'analista_operacao',
  'proprietario',
  'operador',
];

export const ROTULO_PAPEL: Record<Papel, string> = {
  admin: 'Admin',
  analista_automacao: 'Analista de automação',
  analista_operacao: 'Analista de operação',
  proprietario: 'Proprietário',
  operador: 'Operador',
  outro: 'Sem papel',
};

/** Nome do papel na tabela `roles` usado ao CRIAR um usuário daquele papel. */
export const ROLE_DO_PAPEL: Record<Exclude<Papel, 'outro'>, string> = {
  admin: 'admin',
  analista_automacao: 'analista_automacao',
  analista_operacao: 'analista_operacao',
  proprietario: 'proprietario',
  operador: 'operador',
};

export function papelCanonico(role?: string | null): Papel {
  const r = String(role ?? '').trim().toLowerCase().replace(/[-\s]/g, '_');
  switch (r) {
    case 'super_admin':
    case 'superadmin':
    case 'admin':
      return 'admin';
    case 'analista_automacao':
    case 'analista':
      return 'analista_automacao';
    case 'analista_operacao':
    case 'gerente':
      return 'analista_operacao';
    case 'proprietario':
    case 'propietario':
      return 'proprietario';
    case 'operador':
      return 'operador';
    default:
      return 'outro';
  }
}

/** Papéis de escopo global (veem todas as plantas). */
export function isGlobal(papel: Papel): boolean {
  return papel === 'admin' || papel === 'analista_automacao' || papel === 'analista_operacao';
}

/**
 * Quem cadastra quem (seção 3). Vale também para editar e desativar (PER-11),
 * sempre dentro do escopo de quem cadastra.
 */
const CADASTRA: Record<Papel, readonly Papel[]> = {
  admin: ['admin', 'analista_automacao', 'analista_operacao', 'proprietario', 'operador'],
  analista_automacao: ['analista_operacao', 'proprietario', 'operador'],
  analista_operacao: ['proprietario', 'operador'],
  proprietario: ['operador'],
  operador: [],
  outro: [],
};

export function papeisQuePodeCadastrar(autor: Papel): Papel[] {
  return [...CADASTRA[autor]];
}

export function podeCadastrar(autor: Papel, alvo: Papel): boolean {
  return CADASTRA[autor].includes(alvo);
}

/**
 * O que o papel pode, sem olhar escopo. O front usa a mesma tabela (vem no
 * /auth/me) para esconder botão; a proteção é sempre o backend (PER-4).
 */
export interface Capacidades {
  /** Vê todas as plantas. */
  global: boolean;
  /** Cadastro técnico: plantas, instalações, equipamentos, unifilar, IoT. */
  cadastroTecnico: boolean;
  /** Diagrama unifilar (PER-21). */
  verUnifilar: boolean;
  /** Botão e modal de comunicação (PER-22). */
  verComunicacao: boolean;
  /** Contador de falhas na Home. */
  contadorFalhas: boolean;
  /** Nome do proprietário em listas e cabeçalhos (oculto para o próprio proprietário). */
  verNomeProprietario: boolean;
  /** Comandos em equipamento; operador só nos liberados. */
  comandar: boolean;
  /** Configuração de equipamento (técnica), PER-33a. */
  configTecnica: boolean;
  /** Configuração operacional; operador só nos liberados. */
  configOperacional: boolean;
  /** Demanda manual mensal do pivô, grupo "Usina", tarifas. */
  configUsina: boolean;
  tarifas: boolean;
  /** Análise de geração; operador só com "Ver geração" (PER-40). */
  analiseGeracao: boolean;
  /** Valores em R$; operador só com "Ver valores em R$". */
  verValores: boolean;
  /** Marcar planta como teste. */
  marcarPlantaTeste: boolean;
  /** Libera "Ver geração" a operador (PER-16). */
  liberarVerGeracao: boolean;
  /** Edita o acesso de operador (tela Acesso, PER-21b). */
  gerirAcessoOperador: boolean;
  /** Exporta a planilha de recargas do carregador (PER-38). */
  exportarRecargas: boolean;
  /** Papéis que este usuário pode cadastrar. */
  cadastra: Papel[];
}

export function capacidades(papel: Papel): Capacidades {
  const global = isGlobal(papel);
  const dono = global || papel === 'proprietario';
  const operador = papel === 'operador';
  return {
    global,
    cadastroTecnico: papel === 'admin' || papel === 'analista_automacao',
    verUnifilar: dono,
    verComunicacao: dono,
    contadorFalhas: global,
    verNomeProprietario: papel !== 'proprietario',
    comandar: dono || operador,
    configTecnica: global,
    configOperacional: dono || operador,
    configUsina: global,
    tarifas: global,
    analiseGeracao: dono || operador,
    verValores: dono || operador,
    marcarPlantaTeste: papel === 'admin' || papel === 'analista_automacao',
    liberarVerGeracao: dono,
    gerirAcessoOperador: dono,
    exportarRecargas: dono,
    cadastra: papeisQuePodeCadastrar(papel),
  };
}

/**
 * Classe de cada parâmetro (PER-33a/b). Até o cadastro do modelo ganhar o campo
 * `classe`, vale a classificação inicial da spec: só os do pivô listados aqui
 * são operacionais; todo o resto (inversor, DJ, medidor, valor do kWh) é técnico.
 */
export type ClasseParametro = 'tecnica' | 'operacional';

export const PARAMETROS_OPERACIONAIS_PIVO: readonly string[] = [
  'lamina',
  'lamina_mm',
  'tipo_irrigacao',
  'modo_irrigacao',
  'programacao',
  'agenda',
  'bloqueio_ponta',
  'girar_sem_agua',
  'canhao_final',
  'segmentos',
  'angulo_parada',
];

export function podeAlterarClasse(papel: Papel, classe: ClasseParametro): boolean {
  const c = capacidades(papel);
  return classe === 'tecnica' ? c.configTecnica : c.configOperacional;
}

export const MSG_SOMENTE_LEITURA = 'Somente leitura para este perfil';
