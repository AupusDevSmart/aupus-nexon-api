import { Injectable, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTipoEquipamentoDto } from './dto/create-tipo-equipamento.dto';


export interface CampoTecnico {
  campo: string;
  tipo: 'number' | 'text' | 'date' | 'select';
  unidade?: string;
  obrigatorio?: boolean;
  valor_padrao?: any;
  opcoes?: string[];
  descricao?: string;
}

export interface PropriedadesSchema {
  campos: CampoTecnico[];
}

@Injectable()
export class TiposEquipamentosService {
  constructor(private prisma: PrismaService) {}

  /**
   * Busca todos os tipos de equipamentos (modelos)
   * Pode filtrar por categoria_id e pesquisar por nome/código/fabricante
   */
  async findAll(categoria_id?: string, search?: string) {
    // Construir filtros
    const where: any = {};

    if (categoria_id) {
      where.categoria_id = categoria_id;
    }

    if (search) {
      where.OR = [
        { codigo: { contains: search, mode: 'insensitive' } },
        { nome: { contains: search, mode: 'insensitive' } },
        { fabricante: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Buscar tipos de equipamentos com categoria
    const tipos = await this.prisma.tipos_equipamentos.findMany({
      where,
      include: {
        categoria: true,
      },
      orderBy: [
        { categoria: { nome: 'asc' } },
        { nome: 'asc' },
      ],
    });

    // Contar por categoria
    const categorias = await this.prisma.tipos_equipamentos.groupBy({
      by: ['categoria_id'],
      _count: {
        id: true,
      },
    });

    return {
      data: tipos.map((tipo) => ({
        id: tipo.id,
        codigo: tipo.codigo,
        nome: tipo.nome,
        categoriaId: tipo.categoria_id,
        categoria: tipo.categoria,
        fabricante: tipo.fabricante,
        larguraPadrao: tipo.largura_padrao,
        alturaPadrao: tipo.altura_padrao,
        iconeSvg: tipo.icone_svg,
        propriedadesSchema: tipo.propriedades_schema, // Campos técnicos do equipamento
        mqttSchema: tipo.mqtt_schema, // ✅ NOVO: JSON Schema para validação MQTT
        createdAt: tipo.created_at,
        updatedAt: tipo.updated_at,
      })),
      meta: {
        total: tipos.length,
        categorias: categorias.map((cat) => ({
          categoriaId: cat.categoria_id,
          total: cat._count.id,
        })),
      },
    };
  }

  /**
   * Cria um novo tipo de equipamento (modelo)
   */
  async create(dto: CreateTipoEquipamentoDto) {
    // Verificar se a categoria existe
    const categoriaExiste = await this.prisma.categorias_equipamentos.findUnique({
      where: { id: dto.categoriaId },
    });

    if (!categoriaExiste) {
      throw new BadRequestException('Categoria não encontrada');
    }

    // Verificar se já existe tipo com o mesmo código
    const tipoExistente = await this.prisma.tipos_equipamentos.findUnique({
      where: { codigo: dto.codigo },
    });

    if (tipoExistente) {
      throw new ConflictException('Já existe um tipo de equipamento com este código');
    }

    // Criar tipo
    const tipo = await this.prisma.tipos_equipamentos.create({
      data: {
        codigo: dto.codigo,
        nome: dto.nome,
        fabricante: dto.fabricante,
        categoria_id: dto.categoriaId,
        largura_padrao: 100,
        altura_padrao: 100,
        icone_svg: '',
        propriedades_schema: {},
        mqtt_schema: {},
      },
    });

    return {
      id: tipo.id,
      codigo: tipo.codigo,
      nome: tipo.nome,
      categoriaId: tipo.categoria_id,
      categoria: categoriaExiste,
      fabricante: tipo.fabricante,
      larguraPadrao: tipo.largura_padrao,
      alturaPadrao: tipo.altura_padrao,
      iconeSvg: tipo.icone_svg,
      propriedadesSchema: tipo.propriedades_schema,
      mqttSchema: tipo.mqtt_schema,
      createdAt: tipo.created_at,
      updatedAt: tipo.updated_at,
    };
  }

  /**
   * Busca um tipo de equipamento por ID
   */
  async findOne(id: string) {
    const tipo = await this.prisma.tipos_equipamentos.findUnique({
      where: { id },
      include: {
        categoria: true,
      },
    });

    if (!tipo) {
      return null;
    }

    return {
      id: tipo.id,
      codigo: tipo.codigo,
      nome: tipo.nome,
      categoriaId: tipo.categoria_id,
      categoria: tipo.categoria,
      fabricante: tipo.fabricante,
      larguraPadrao: tipo.largura_padrao,
      alturaPadrao: tipo.altura_padrao,
      iconeSvg: tipo.icone_svg,
      propriedadesSchema: tipo.propriedades_schema, // Campos técnicos do equipamento
      mqttSchema: tipo.mqtt_schema, // ✅ NOVO: JSON Schema para validação MQTT
      createdAt: tipo.created_at,
      updatedAt: tipo.updated_at,
    };
  }

  /**
   * Busca um tipo de equipamento por código
   */
  async findByCode(codigo: string) {
    const tipo = await this.prisma.tipos_equipamentos.findUnique({
      where: { codigo },
      include: {
        categoria: true,
      },
    });

    if (!tipo) {
      return null;
    }

    return {
      id: tipo.id,
      codigo: tipo.codigo,
      nome: tipo.nome,
      categoriaId: tipo.categoria_id,
      categoria: tipo.categoria,
      fabricante: tipo.fabricante,
      larguraPadrao: tipo.largura_padrao,
      alturaPadrao: tipo.altura_padrao,
      iconeSvg: tipo.icone_svg,
      propriedadesSchema: tipo.propriedades_schema, // Campos técnicos do equipamento
      mqttSchema: tipo.mqtt_schema, // ✅ NOVO: JSON Schema para validação MQTT
      createdAt: tipo.created_at,
      updatedAt: tipo.updated_at,
    };
  }

  /**
   * Retorna os campos técnicos padrão para um tipo de equipamento
   */
  async getCamposTecnicos(id: string): Promise<CampoTecnico[]> {
    const tipo = await this.prisma.tipos_equipamentos.findUnique({
      where: { id },
      select: { propriedades_schema: true },
    });

    if (!tipo || !tipo.propriedades_schema) {
      return [];
    }

    const schema = tipo.propriedades_schema as unknown as PropriedadesSchema;
    return schema.campos || [];
  }

  /**
   * Retorna os campos técnicos padrão para um tipo de equipamento por código
   */
  async getCamposTecnicosByCode(codigo: string): Promise<CampoTecnico[]> {
    const tipo = await this.prisma.tipos_equipamentos.findUnique({
      where: { codigo },
      select: { propriedades_schema: true },
    });

    if (!tipo || !tipo.propriedades_schema) {
      return [];
    }

    const schema = tipo.propriedades_schema as unknown as PropriedadesSchema;
    return schema.campos || [];
  }

  /**
   * Retorna todas as categorias disponíveis (DEPRECATED - usar CategoriasEquipamentosService)
   * Mantido por compatibilidade com código existente
   */
  async getCategorias() {
    const categorias = await this.prisma.categorias_equipamentos.findMany({
      include: {
        _count: {
          select: {
            modelos: true,
          },
        },
      },
      orderBy: {
        nome: 'asc',
      },
    });

    return categorias.map((cat) => ({
      id: cat.id,
      nome: cat.nome,
      total: cat._count.modelos,
    }));
  }

  /**
   * Retorna estatísticas sobre os tipos de equipamentos
   */
  async getEstatisticas() {
    const [total, porCategoria] = await Promise.all([
      this.prisma.tipos_equipamentos.count(),
      this.prisma.tipos_equipamentos.groupBy({
        by: ['categoria_id'],
        _count: {
          id: true,
        },
      }),
    ]);

    // Buscar nomes das categorias
    const categoriaIds = porCategoria.map((cat) => cat.categoria_id);
    const categorias = await this.prisma.categorias_equipamentos.findMany({
      where: {
        id: {
          in: categoriaIds,
        },
      },
    });

    const categoriasMap = new Map(categorias.map((cat) => [cat.id, cat.nome]));

    return {
      total,
      categorias: porCategoria.map((cat) => ({
        categoriaId: cat.categoria_id,
        categoriaNome: categoriasMap.get(cat.categoria_id) || 'Desconhecida',
        total: cat._count.id,
      })),
    };
  }
}
