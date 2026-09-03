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
 * Documentos da instalacao: contrato de fornecimento, diagrama, laudo, ART.
 *
 * Espelha AnexosEquipamentosService. O download passa pelo controller, e nao por
 * URL estatica, entao nao depende da rota do UploadsController — que e duplicada
 * nos dois backends e ja causou 404 silencioso na foto do equipamento.
 */
@Injectable()
export class AnexosUnidadesService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'unidades-anexos');

  /** PDF, imagem e os formatos de escritorio — o que se anexa a uma instalacao. */
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

  private async assertUnidadeExiste(unidadeId: string) {
    const equipamento = await this.prisma.unidades.findFirst({
      where: { id: unidadeId, deleted_at: null },
      select: { id: true },
    });

    if (!equipamento) {
      throw new NotFoundException('Instalação não encontrada');
    }
  }

  async uploadAnexo(unidadeId: string, file: any, descricao?: string) {
    const id = unidadeId?.trim();
    await this.assertUnidadeExiste(id);

    if (!file) {
      throw new BadRequestException('Nenhum arquivo enviado');
    }

    if (!AnexosUnidadesService.MIMES_PERMITIDOS.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de arquivo não permitido. Aceitos: PDF, PNG, JPG, WEBP, DOC, DOCX, XLS, XLSX, TXT, ZIP',
      );
    }

    if (file.size > AnexosUnidadesService.TAMANHO_MAXIMO) {
      throw new BadRequestException('Arquivo muito grande. Tamanho máximo: 20MB');
    }

    try {
      const ext = path.extname(file.originalname);
      const nomeArquivo = `${id}_${Date.now()}${ext}`;
      const caminhoCompleto = path.join(this.uploadDir, nomeArquivo);

      await writeFile(caminhoCompleto, file.buffer);

      return await this.prisma.anexos_unidades.create({
        data: {
          unidade_id: id,
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

  async listarAnexos(unidadeId: string) {
    const id = unidadeId?.trim();
    await this.assertUnidadeExiste(id);

    return await this.prisma.anexos_unidades.findMany({
      where: { unidade_id: id, deleted_at: null },
      // O id desempata: created_at tem precisão de segundo e dois anexos
      // enviados juntos ficariam em ordem instável entre requisições.
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
  }

  async buscarAnexo(anexoId: string) {
    const anexo = await this.prisma.anexos_unidades.findFirst({
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

  async removerAnexo(anexoId: string) {
    const anexo = await this.buscarAnexo(anexoId);

    try {
      // O arquivo só sai do disco quando nenhum outro registro aponta para ele.
      // Hoje cada anexo de instalação tem o seu arquivo, então a contagem sempre
      // dá zero; fica como guarda porque o dia em que alguém compartilhar um
      // arquivo entre registros — como o cadastro em lote de equipamentos faz —
      // apagar direto deixaria os outros baixando 404.
      const outrosUsos = await this.prisma.anexos_unidades.count({
        where: {
          caminho: anexo.caminho,
          deleted_at: null,
          id: { not: anexo.id },
        },
      });

      if (outrosUsos === 0 && fs.existsSync(anexo.caminho)) {
        await unlink(anexo.caminho);
      }

      await this.prisma.anexos_unidades.update({
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
