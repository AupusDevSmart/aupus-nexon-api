import { Prisma } from '@prisma/client';

export const RECURSOS = ['usuarios', 'plantas', 'unidades', 'equipamentos'] as const;
export type Recurso = (typeof RECURSOS)[number];

export function ehRecurso(v: string): v is Recurso {
  return (RECURSOS as readonly string[]).includes(v);
}

/**
 * O que NUNCA atravessa a fronteira.
 *
 * Lista de NEGACAO, derivada do DMMF em vez de uma lista de campos permitidos
 * escrita a mao. Ja custou caro neste projeto: o endpoint de lote de UAR tinha
 * uma lista de permissao e perdia 33 de 46 colunas em silencio, porque cada
 * coluna nova nascia fora dela. Com negacao, coluna nova viaja sozinha e o
 * esquecimento erra para o lado seguro.
 */
const NUNCA_VIAJAM: Record<Recurso, string[]> = {
  usuarios: [
    // Credencial nao se replica. Nunca.
    'senha',
    'remember_token',
    // `role` e a coluna legada que espelha o Spatie. Privilegio nao viaja junto
    // com cadastro: os dois bancos tem 6 roles e 39 permissions com guards
    // `web`/`api` misturados, e propagar isso transformaria um botao de
    // compartilhar em escalada de acesso. Quem recebe atribui papel no destino.
    'role',
    // Apontam para tabelas que nao estao sob sincronizacao. Levar o id sem
    // levar a linha cria referencia pendurada — que nao da erro, so devolve
    // nulo quando alguem for ler.
    'concessionaria_atual_id',
    'organizacao_atual_id',
    'manager_id',
    'created_by',
    'deleted_by',
  ],
  plantas: [],
  unidades: [],
  // O NexOn nao tem as colunas de posicao: nao ha o que excluir aqui.
  equipamentos: [],
};

/**
 * O que precisa existir do outro lado antes do registro poder chegar.
 *
 * A sincronizacao RECUSA quando falta dependencia, em vez de arrastar junto o
 * que falta. Um clique em "compartilhar equipamento" que silenciosamente copia
 * um usuario e os privilegios dele para o outro produto e um buraco de
 * seguranca, nao uma conveniencia.
 */
export interface Dependencia {
  campo: string;
  /** Tabela onde procurar. Nem toda dependencia e um recurso sincronizavel. */
  tabela: string;
  comoChamar: string;
}

export const DEPENDENCIAS: Record<Recurso, Dependencia[]> = {
  usuarios: [],
  plantas: [{ campo: 'proprietario_id', tabela: 'usuarios', comoChamar: 'o proprietário' }],
  unidades: [{ campo: 'planta_id', tabela: 'plantas', comoChamar: 'a planta' }],
  equipamentos: [
    { campo: 'unidade_id', tabela: 'unidades', comoChamar: 'a instalação' },
    { campo: 'equipamento_pai_id', tabela: 'equipamentos', comoChamar: 'o equipamento pai' },
    // O catalogo esta sincronizado hoje (37 tipos e 20 categorias com os mesmos
    // ids nos dois bancos), mas conferir e barato e o dia em que divergir o erro
    // sera claro em vez de virar equipamento sem categoria do outro lado.
    { campo: 'tipo_equipamento_id', tabela: 'tipos_equipamentos', comoChamar: 'o tipo de equipamento' },
  ],
};

/** Os campos escalares do model, menos os que nunca viajam. */
export function camposQueViajam(recurso: Recurso): string[] {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === recurso);
  if (!model) throw new Error(`Recurso sem model no schema: ${recurso}`);

  const proibidos = new Set(NUNCA_VIAJAM[recurso]);
  return model.fields
    .filter(f => f.kind === 'scalar' && !proibidos.has(f.name))
    .map(f => f.name);
}

/**
 * Monta o payload de saida a partir da linha do banco.
 *
 * Ids saem TRIMADOS: as tabelas sao `char(26)` e devolvem com padding, e mandar
 * o padding pela rede faria o outro lado gravar um id diferente do proprio id.
 * `Date` vira ISO e `Decimal`/`BigInt` viram string porque JSON nao tem os tres.
 */
export function montarPayload(recurso: Recurso, linha: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {};

  for (const campo of camposQueViajam(recurso)) {
    const v = linha[campo];
    if (v === undefined) continue;

    if (v === null) payload[campo] = null;
    else if (v instanceof Date) payload[campo] = v.toISOString();
    else if (typeof v === 'bigint') payload[campo] = v.toString();
    else if (typeof v === 'object' && typeof (v as any).toFixed === 'function') payload[campo] = (v as any).toString();
    else if (typeof v === 'string' && campo.endsWith('_id')) payload[campo] = v.trim();
    else payload[campo] = v;
  }

  if (typeof payload.id === 'string') payload.id = payload.id.trim();
  return payload;
}

/**
 * Filtra o payload recebido contra o schema DESTE backend.
 *
 * O remetente nao conhece a forma do destinatario, e nao deve conhecer — e por
 * isso que a sincronizacao passa por HTTP e nao por escrita cruzada no banco.
 * Campo que este lado nao tem e descartado aqui, sem erro: e assim que o
 * equipamento do Service (55 colunas) entra no NexOn (53) sem ninguem precisar
 * manter um tradutor dos dois lados.
 */
export function filtrarParaEsteBanco(
  recurso: Recurso,
  payload: Record<string, any>,
): { dados: Record<string, any>; ignorados: string[] } {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === recurso);
  if (!model) throw new Error(`Recurso sem model no schema: ${recurso}`);

  const conhecidos = new Map(model.fields.filter(f => f.kind === 'scalar').map(f => [f.name, f]));
  const proibidos = new Set(NUNCA_VIAJAM[recurso]);

  const dados: Record<string, any> = {};
  const ignorados: string[] = [];

  for (const [campo, valor] of Object.entries(payload)) {
    const f = conhecidos.get(campo);
    // Um remetente comprometido nao consegue gravar senha por aqui: a barreira
    // vale nos DOIS sentidos, nao so na saida.
    if (!f || proibidos.has(campo)) { ignorados.push(campo); continue; }

    if (valor === null) { dados[campo] = null; continue; }

    switch (f.type) {
      case 'DateTime': dados[campo] = new Date(valor); break;
      case 'BigInt':   dados[campo] = BigInt(valor); break;
      case 'Decimal':  dados[campo] = new Prisma.Decimal(valor); break;
      case 'Int':      dados[campo] = Number(valor); break;
      default:         dados[campo] = typeof valor === 'string' && campo.endsWith('_id') ? valor.trim() : valor;
    }
  }

  return { dados, ignorados };
}
