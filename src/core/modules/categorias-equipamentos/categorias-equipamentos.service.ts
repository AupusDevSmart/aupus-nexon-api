import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoriaEquipamentoDto } from './dto/create-categoria-equipamento.dto';
import { UpdateCategoriaEquipamentoDto } from './dto/update-categoria-equipamento.dto';

@Injectable()
export class CategoriasEquipamentosService {
  constructor(private prisma: PrismaService) {}

  async create(createCategoriaEquipamentoDto: CreateCategoriaEquipamentoDto) {
    return this.prisma.categorias_equipamentos.create({
      data: createCategoriaEquipamentoDto,
    });
  }

  async findAll() {
    return this.prisma.categorias_equipamentos.findMany({
      orderBy: {
        nome: 'asc',
      },
      include: {
        _count: {
          select: {
            modelos: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const categoria = await this.prisma.categorias_equipamentos.findUnique({
      where: { id },
      include: {
        modelos: {
          orderBy: {
            nome: 'asc',
          },
        },
        _count: {
          select: {
            modelos: true,
          },
        },
      },
    });

    if (!categoria) {
      throw new NotFoundException(
        `Categoria de equipamento com ID ${id} não encontrada`,
      );
    }

    return categoria;
  }

  async update(
    id: string,
    updateCategoriaEquipamentoDto: UpdateCategoriaEquipamentoDto,
  ) {
    await this.findOne(id); // Verifica se existe

    return this.prisma.categorias_equipamentos.update({
      where: { id },
      data: updateCategoriaEquipamentoDto,
    });
  }

  async remove(id: string) {
    await this.findOne(id); // Verifica se existe

    // Verifica se há modelos associados
    const count = await this.prisma.tipos_equipamentos.count({
      where: { categoria_id: id },
    });

    if (count > 0) {
      throw new Error(
        `Não é possível excluir a categoria. Existem ${count} modelos associados.`,
      );
    }

    return this.prisma.categorias_equipamentos.delete({
      where: { id },
    });
  }
}
