/**
 * DTOs do catalogo IoT.
 *
 * Tipos opacos (Json) — o shape interno de `pontos` e `mapeamento` evolui
 * livremente sem mudar contrato HTTP. Validacao estrutural fica a cargo da
 * UI admin (Fase 3) com schema dedicado.
 */

export interface IotDeviceTipoDto {
  /** Identificador canonico (ex: "inversor_solar", "rele_protecao"). */
  codigo: string;
  /** Nome amigavel exibido na UI. */
  nome: string;
  /**
   * Contrato canonico de pontos do tipo.
   * Shape: { ai: Point[], bi: Point[], bo: Point[], group_order?: string[], publish?: object, label?: string }
   */
  pontos: Record<string, unknown>;
}

export interface IotDeviceModeloDto {
  /** Slug historico do modelo no catalogo (ex: "sungrow-sg250cx"). */
  catalog_id: string;
  fabricante: string;
  modelo: string;
  /** Codigo do tipo (FK resolvida — `iot_device_tipos.codigo`). */
  tipo: string;
  protocolo: string;
  connection_note: string | null;
  /**
   * Mapeamento Modbus completo.
   * Shape: { ai_blocks, ai_map, bi_map, bo_map, num_mppts?, num_strings?, word_order?, tp_tc?, kd?, scales?, handshake?, ... }
   * (catalog_id eh elevado pra coluna; nao aparece aqui em duplicidade.)
   */
  mapeamento: Record<string, unknown>;
}

export interface IotCatalogResponseDto {
  /** ETag-like — `MAX(updated_at)` das duas tabelas, em ms. */
  version: string;
  tipos: IotDeviceTipoDto[];
  modelos: IotDeviceModeloDto[];
}
