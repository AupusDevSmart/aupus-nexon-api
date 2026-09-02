import { TipoUnidade, StatusUnidade, GrupoUnidade, SubgrupoUnidade, TipoUnidadeEnergia } from '../dto/create-unidade.dto';

export class Unidade {
  id: string;
  plantaId: string;
  nome: string;
  tipo: TipoUnidade;
  estado: string;
  cidade: string;
  latitude: number;
  longitude: number;
  potencia: number;
  status: StatusUnidade;
  pontosMedicao?: string[];
  irrigante?: boolean;
  grupo?: GrupoUnidade;
  subgrupo?: SubgrupoUnidade;
  tipoUnidade?: TipoUnidadeEnergia;
  demandaCarga?: number;
  demandaGeracao?: number;
  concessionariaId?: string;
  criadoEm: Date;
  atualizadoEm: Date;
  deletadoEm?: Date | null;
}
