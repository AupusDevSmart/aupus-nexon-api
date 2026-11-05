import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlantaDto } from '@/core/modules/plantas/dto/create-planta.dto';
import { UpdatePlantaDto } from '@/core/modules/plantas/dto/update-planta.dto';
import { CreateUnidadeDto } from '@/core/modules/unidades/dto/create-unidade.dto';
import { UpdateUnidadeDto } from '@/core/modules/unidades/dto/update-unidade.dto';

/**
 * Cadastro de planta e instalacao com quase nada obrigatorio (nov/2026), pelo
 * mesmo caminho do ValidationPipe global de main.ts: conversao implicita
 * ligada, whitelist e forbidNonWhitelisted.
 */
async function pelaPipe<T extends object>(cls: new () => T, corpo: Record<string, unknown>) {
  const dto = plainToInstance(cls, corpo, { enableImplicitConversion: true });
  const erros = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, campos: erros.map((e) => e.property) };
}

describe('VazioEhNulo nos cadastros de planta e instalacao', () => {
  it('planta so com o nome passa', async () => {
    const { campos } = await pelaPipe(CreatePlantaDto, { nome: 'Fazenda Boa Vista' });
    expect(campos).toEqual([]);
  });

  it('planta sem nome continua recusada', async () => {
    const { campos } = await pelaPipe(CreatePlantaDto, { cnpj: '' });
    expect(campos).toEqual(['nome']);
  });

  it('campos vazios da planta viram null, inclusive no endereco', async () => {
    const { dto, campos } = await pelaPipe(CreatePlantaDto, {
      nome: 'Fazenda Boa Vista',
      cnpj: '',
      proprietarioId: '  ',
      horarioFuncionamento: '',
      localizacao: '',
      endereco: { logradouro: '', bairro: '', cidade: '', uf: '', cep: '' },
    });
    expect(campos).toEqual([]);
    expect(dto.cnpj).toBeNull();
    expect(dto.proprietarioId).toBeNull();
    expect(dto.horarioFuncionamento).toBeNull();
    expect(dto.localizacao).toBeNull();
    expect(dto.endereco).toEqual({ logradouro: null, bairro: null, cidade: null, uf: null, cep: null });
  });

  it('campo preenchido da planta ainda tem o formato conferido', async () => {
    const { campos } = await pelaPipe(CreatePlantaDto, {
      nome: 'Fazenda Boa Vista',
      cnpj: '123',
      endereco: { cep: '1234' },
    });
    expect(campos.sort()).toEqual(['cnpj', 'endereco']);
  });

  it('no update, vazio apaga (null) e ausente mantem (undefined)', async () => {
    const { dto, campos } = await pelaPipe(UpdatePlantaDto, { cnpj: '', proprietarioId: null });
    expect(campos).toEqual([]);
    expect(dto.cnpj).toBeNull();
    expect(dto.proprietarioId).toBeNull();
    expect(dto.localizacao).toBeUndefined();
  });

  it('instalacao so com nome e planta passa', async () => {
    const { campos } = await pelaPipe(CreateUnidadeDto, { nome: 'UFV 1', planta_id: 'p1' });
    expect(campos).toEqual([]);
  });

  it('instalacao sem nome ou sem planta continua recusada', async () => {
    const { campos } = await pelaPipe(CreateUnidadeDto, { tipo: '' });
    expect(campos.sort()).toEqual(['nome', 'planta_id']);
  });

  it('coordenada e potencia vazias viram null, nao 0 (a conversao implicita dava 0)', async () => {
    const { dto, campos } = await pelaPipe(CreateUnidadeDto, {
      nome: 'UFV 1',
      planta_id: 'p1',
      tipo: '',
      estado: '',
      cidade: '',
      latitude: '',
      longitude: '',
      potencia: '',
    });
    expect(campos).toEqual([]);
    expect(dto).toMatchObject({
      tipo: null, estado: null, cidade: null, latitude: null, longitude: null, potencia: null,
    });
  });

  it('numero da instalacao preenchido ainda e conferido', async () => {
    const { dto, campos } = await pelaPipe(CreateUnidadeDto, {
      nome: 'UFV 1',
      planta_id: 'p1',
      latitude: '-23.5',
      longitude: 200,
      potencia: true,
      estado: 'sp',
    });
    expect(dto.latitude).toBe(-23.5);
    expect(campos.sort()).toEqual(['estado', 'longitude', 'potencia']);
  });

  it('update da instalacao herda a regra do create', async () => {
    const { dto, campos } = await pelaPipe(UpdateUnidadeDto, { latitude: '', potencia: '' });
    expect(campos).toEqual([]);
    expect(dto.latitude).toBeNull();
    expect(dto.potencia).toBeNull();
    expect(dto.cidade).toBeUndefined();
  });
});
