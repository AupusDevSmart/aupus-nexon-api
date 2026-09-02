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

@Injectable()
export class AnexosConcessionariasService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'concessionarias');

  constructor(private prisma: PrismaService) {
    this.ensureUploadDirExists();
  }

  private async ensureUploadDirExists() {
    try {
      if (!fs.existsSync(this.uploadDir)) {
        await mkdir(this.uploadDir, { recursive: true });
      }
    } catch (error) {
      console.error('Erro ao criar diretório de uploads:', error);
    }
  }

  async uploadAnexo(
    concessionariaId: string,
    file: any,
    descricao?: string,
  ) {
    // Verificar se concessionária existe
    const concessionaria = await this.prisma.concessionarias_energia.findFirst({
      where: { id: concessionariaId, deleted_at: null },
    });

    if (!concessionaria) {
      throw new NotFoundException('Concessionária não encontrada');
    }

    // Validar tipo de arquivo
    const allowedMimes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];

    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de arquivo não permitido. Formatos aceitos: PDF, PNG, JPG, DOC, DOCX, XLS, XLSX',
      );
    }

    // Validar tamanho (máximo 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new BadRequestException('Arquivo muito grande. Tamanho máximo: 10MB');
    }

    try {
      // Gerar nome único para o arquivo
      const timestamp = Date.now();
      const ext = path.extname(file.originalname);
      const nomeArquivo = `${concessionariaId}_${timestamp}${ext}`;
      const caminhoCompleto = path.join(this.uploadDir, nomeArquivo);

      // Salvar arquivo
      await writeFile(caminhoCompleto, file.buffer);

      // Criar registro no banco
      const anexo = await this.prisma.anexos_concessionarias_energia.create({
        data: {
          concessionaria_id: concessionariaId,
          nome_original: file.originalname,
          nome_arquivo: nomeArquivo,
          caminho: caminhoCompleto,
          mime_type: file.mimetype,
          tamanho: file.size,
          descricao: descricao || null,
        },
      });

      return anexo;
    } catch (error) {
      console.error('Erro ao fazer upload do anexo:', error);
      throw new InternalServerErrorException('Erro ao fazer upload do arquivo');
    }
  }

  async listarAnexosConcessionaria(concessionariaId: string) {
    const concessionaria = await this.prisma.concessionarias_energia.findFirst({
      where: { id: concessionariaId, deleted_at: null },
    });

    if (!concessionaria) {
      throw new NotFoundException('Concessionária não encontrada');
    }

    return await this.prisma.anexos_concessionarias_energia.findMany({
      where: {
        concessionaria_id: concessionariaId,
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async buscarAnexo(anexoId: string) {
    const anexo = await this.prisma.anexos_concessionarias_energia.findFirst({
      where: { id: anexoId, deleted_at: null },
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

  async removerAnexo(anexoId: string) {
    const anexo = await this.buscarAnexo(anexoId);

    try {
      // Remover arquivo físico
      if (fs.existsSync(anexo.caminho)) {
        await unlink(anexo.caminho);
      }

      // Soft delete no banco
      await this.prisma.anexos_concessionarias_energia.update({
        where: { id: anexoId },
        data: { deleted_at: new Date() },
      });

      return { message: 'Anexo removido com sucesso' };
    } catch (error) {
      console.error('Erro ao remover anexo:', error);
      throw new InternalServerErrorException('Erro ao remover anexo');
    }
  }
}
