import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

/**
 * Manuais, datasheets e documentos do equipamento.
 *
 * Espelha AnexosConcessionariasService. O download passa pelo controller, e nao
 * por URL estatica, entao nao depende da rota do UploadsController — que e
 * duplicada nos dois backends e ja causou 404 silencioso na foto do
 * equipamento.
 */
@Injectable()
export class AnexosEquipamentosService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'equipamentos-anexos');

  /** PDF, imagem e os formatos de escritorio — o que se anexa a um equipamento. */
  private static readonly MIMES_PERMITIDOS = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'application/zip',
  ];

  private static readonly TAMANHO_MAXIMO = 20 * 1024 * 1024; // 20MB

  constructor(private prisma: PrismaService) {
    this.ensureUploadDirExists();
  }

  private async ensureUploadDirExists() {
    try {
      if (!fs.existsSync(this.uploadDir)) {
        await mkdir(this.uploadDir, { recursive: true });
      }
    } catch (error) {
      console.error('Erro ao criar diretório de uploads de anexos:', error);
    }
  }

  private async assertEquipamentoExiste(equipamentoId: string) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
      select: { id: true },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }
  }

  async uploadAnexo(equipamentoId: string, file: any, descricao?: string) {
    const id = equipamentoId?.trim();
    await this.assertEquipamentoExiste(id);

    if (!file) {
      throw new BadRequestException('Nenhum arquivo enviado');
    }

    if (!AnexosEquipamentosService.MIMES_PERMITIDOS.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de arquivo não permitido. Aceitos: PDF, PNG, JPG, WEBP, DOC, DOCX, XLS, XLSX, TXT, ZIP',
      );
    }

    if (file.size > AnexosEquipamentosService.TAMANHO_MAXIMO) {
      throw new BadRequestException('Arquivo muito grande. Tamanho máximo: 20MB');
    }

    try {
      const ext = path.extname(file.originalname);
      const nomeArquivo = `${id}_${Date.now()}${ext}`;
      const caminhoCompleto = path.join(this.uploadDir, nomeArquivo);

      await writeFile(caminhoCompleto, file.buffer);

      return await this.prisma.anexos_equipamentos.create({
        data: {
          equipamento_id: id,
          nome_original: file.originalname,
          nome_arquivo: nomeArquivo,
          caminho: caminhoCompleto,
          mime_type: file.mimetype,
          tamanho: file.size,
          descricao: descricao || null,
        },
      });
    } catch (error) {
      console.error('Erro ao fazer upload do anexo:', error);
      throw new InternalServerErrorException('Erro ao fazer upload do arquivo');
    }
  }

  async listarAnexos(equipamentoId: string) {
    const id = equipamentoId?.trim();
    await this.assertEquipamentoExiste(id);

    return await this.prisma.anexos_equipamentos.findMany({
      where: { equipamento_id: id, deleted_at: null },
      // O id desempata: created_at tem precisão de segundo e dois anexos
      // enviados juntos ficariam em ordem instável entre requisições.
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
  }

  async buscarAnexo(anexoId: string) {
    const anexo = await this.prisma.anexos_equipamentos.findFirst({
      where: { id: anexoId?.trim(), deleted_at: null },
    });

    if (!anexo) {
      throw new NotFoundException('Anexo não encontrado');
    }

    return anexo;
  }

  async obterCaminhoArquivo(anexoId: string): Promise<string> {
    const anexo = await this.buscarAnexo(anexoId);

    if (!fs.existsSync(anexo.caminho)) {
      throw new NotFoundException('Arquivo não encontrado no servidor');
    }

    return anexo.caminho;
  }

  /**
   * Copia a lista de anexos de um equipamento para outros.
   *
   * Os registros são novos e independentes — cada equipamento remove ou
   * acrescenta o que quiser depois —, mas todos apontam para o MESMO arquivo em
   * disco. Vinte equipamentos do mesmo modelo compartilham o mesmo manual, e
   * gravar vinte cópias de um PDF de 10MB é desperdício puro.
   *
   * É esse compartilhamento que obriga `removerAnexo` a contar referências
   * antes de apagar o arquivo.
   */
  async replicarAnexos(origemId: string, destinoIds: string[]) {
    const origem = origemId?.trim();
    const destinos = [...new Set((destinoIds || []).map((d) => d?.trim()).filter(Boolean))]
      .filter((d) => d !== origem);

    if (destinos.length === 0) {
      return { total: 0, anexos_por_equipamento: 0 };
    }

    await this.assertEquipamentoExiste(origem);

    const existentes = await this.prisma.equipamentos.findMany({
      where: { id: { in: destinos }, deleted_at: null },
      select: { id: true },
    });

    const validos = existentes.map((e) => e.id);
    if (validos.length !== destinos.length) {
      throw new NotFoundException(
        'Algum equipamento de destino não foi encontrado',
      );
    }

    const anexos = await this.prisma.anexos_equipamentos.findMany({
      where: { equipamento_id: origem, deleted_at: null },
    });

    if (anexos.length === 0) {
      return { total: 0, anexos_por_equipamento: 0 };
    }

    const novos = validos.flatMap((destino) =>
      anexos.map((anexo) => ({
        equipamento_id: destino,
        nome_original: anexo.nome_original,
        nome_arquivo: anexo.nome_arquivo,
        caminho: anexo.caminho,
        mime_type: anexo.mime_type,
        tamanho: anexo.tamanho,
        descricao: anexo.descricao,
      })),
    );

    const resultado = await this.prisma.anexos_equipamentos.createMany({
      data: novos,
    });

    return {
      total: resultado.count,
      anexos_por_equipamento: anexos.length,
    };
  }

  async removerAnexo(anexoId: string) {
    const anexo = await this.buscarAnexo(anexoId);

    try {
      // O arquivo só sai do disco quando ninguém mais aponta para ele. Anexos
      // replicados compartilham o arquivo, e apagar direto deixaria os outros
      // equipamentos com um registro que baixa 404.
      const outrosUsos = await this.prisma.anexos_equipamentos.count({
        where: {
          caminho: anexo.caminho,
          deleted_at: null,
          id: { not: anexo.id },
        },
      });

      if (outrosUsos === 0 && fs.existsSync(anexo.caminho)) {
        await unlink(anexo.caminho);
      }

      await this.prisma.anexos_equipamentos.update({
        where: { id: anexo.id },
        data: { deleted_at: new Date() },
      });

      return { message: 'Anexo removido com sucesso' };
    } catch (error) {
      console.error('Erro ao remover anexo:', error);
      throw new InternalServerErrorException('Erro ao remover anexo');
    }
  }
}
