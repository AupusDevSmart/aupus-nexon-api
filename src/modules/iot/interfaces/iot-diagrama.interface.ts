/**
 * Estrutura JSON persistida em `iot_projetos.diagrama` (PostgreSQL JSONB).
 *
 * O shape exato dos componentes/conexoes eh ditado pelo editor SVG legado
 * (`/iot-diagram.v2.js` no frontend) — a TON consome o mesmo shape via API
 * REST, e o backend nao interpreta os campos individuais. Por isso usamos
 * Record<string, unknown> em vez de modelar cada componente, mas marcamos
 * os campos minimos (id, type, x, y) que o frontend espera.
 */
export interface IotDiagramaComponent {
  /** ID local do componente dentro do diagrama (gerado pelo editor) */
  id: string | number;
  /** Tipo (TON, ESP32, sensor, etc.) — match com COMPONENT_TYPES do JS bridge */
  type: string;
  /** Posicao no canvas SVG */
  x: number;
  y: number;
  /** Outros campos especificos do tipo (resolvidos pelo editor) */
  [key: string]: unknown;
}

export interface IotDiagramaConnection {
  id: string | number;
  /** ID dos componentes endpoint da conexao */
  from: string | number;
  to: string | number;
  /** Outros campos (estilo, label, anchors) */
  [key: string]: unknown;
}

export interface IotDiagramaPan {
  x: number;
  y: number;
}

export interface IotDiagrama {
  components: IotDiagramaComponent[];
  connections: IotDiagramaConnection[];
  /** Proximo ID auto-incrementado pelo editor */
  nextId?: number;
  /** Posicao da camera */
  pan?: IotDiagramaPan;
  zoom?: number;
}

/**
 * Linha bruta da tabela `iot_projetos`.
 * Usado em retornos de queries raw (a tabela nao esta em api-shared/schema.prisma
 * porque eh gerenciada pelo /var/www/iot_nexon/).
 */
export interface IotProjetoRow {
  id: string;
  unidade_id: string;
  nome: string;
  diagrama: IotDiagrama;
  created_at: Date;
  updated_at: Date;
}
