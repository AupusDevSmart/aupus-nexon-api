import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@aupus/api-shared';

@Public() // Rotas públicas (sem autenticação)
@ApiExcludeController() // Não incluir no Swagger
@Controller('uploads')
export class UploadsController {

  @Get('test')
  @ApiOperation({ summary: 'Test endpoint' })
  test() {
    return { message: 'Uploads controller is working!' };
  }

  @Get('avatars/:filename')
  @ApiOperation({ summary: 'Serve avatar image' })
  @ApiResponse({ status: 200, description: 'Image file' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async serveAvatar(@Param('filename') filename: string, @Res() res: Response) {
    try {
      const filePath = join(process.cwd(), 'uploads', 'avatars', filename);

      console.log('📁 Tentando servir arquivo:', filePath);

      if (!existsSync(filePath)) {
        console.error('❌ Arquivo não encontrado:', filePath);
        return res.status(HttpStatus.NOT_FOUND).json({
          message: 'File not found',
          path: filePath
        });
      }

      console.log('✅ Arquivo encontrado, enviando:', filePath);
      return res.sendFile(filePath);
    } catch (error) {
      console.error('❌ Erro ao servir arquivo:', error);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        message: 'Error serving file',
        error: error.message
      });
    }
  }

  @Get('tarefas/:filename')
  @ApiOperation({ summary: 'Serve task attachment' })
  @ApiResponse({ status: 200, description: 'File' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async serveTaskFile(@Param('filename') filename: string, @Res() res: Response) {
    try {
      const filePath = join(process.cwd(), 'uploads', 'tarefas', filename);

      if (!existsSync(filePath)) {
        return res.status(HttpStatus.NOT_FOUND).json({
          message: 'File not found'
        });
      }

      return res.sendFile(filePath);
    } catch (error) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        message: 'Error serving file',
        error: error.message
      });
    }
  }
}