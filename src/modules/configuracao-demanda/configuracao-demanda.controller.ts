import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfiguracaoDemandaService } from './configuracao-demanda.service';
import { CreateConfiguracaoDemandaDto } from './dto/create-configuracao-demanda.dto';
import { UpdateConfiguracaoDemandaDto } from './dto/update-configuracao-demanda.dto';
import { JwtAuthGuard } from '@aupus/api-shared';

@Controller('configuracao-demanda')
// @UseGuards(JwtAuthGuard) // Temporariamente desabilitado para testes
export class ConfiguracaoDemandaController {
  constructor(
    private readonly configuracaoDemandaService: ConfiguracaoDemandaService,
  ) {}

  @Get('test')
  test() {
    return {
      message: 'ConfiguracaoDemanda controller is working!',
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  async findAll() {
    return this.configuracaoDemandaService.findAll();
  }

  @Get('unidade/:unidadeId')
  async findByUnidade(@Param('unidadeId') unidadeId: string) {
    const configuracao = await this.configuracaoDemandaService.findByUnidade(unidadeId);

    if (!configuracao) {
      return {
        unidade_id: unidadeId,
        fonte: 'AGRUPAMENTO',
        equipamentos_ids: [],
        mostrar_detalhes: true,
        intervalo_atualizacao: 30,
        aplicar_perdas: true,
        fator_perdas: 3.0,
        valor_contratado: null,
        percentual_adicional: 10.0,
        exists: false
      };
    }

    return {
      ...configuracao,
      exists: true
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() createDto: CreateConfiguracaoDemandaDto,
    @Request() req: any,
  ) {
    const userId = req.user?.id;
    return this.configuracaoDemandaService.create(createDto, userId);
  }

  // IMPORTANTE: Rota mais específica deve vir ANTES da rota com parâmetro genérico
  @Put('unidade/:unidadeId')
  async updateByUnidade(
    @Param('unidadeId') unidadeId: string,
    @Body() updateDto: UpdateConfiguracaoDemandaDto,
    @Request() req: any,
  ) {
    console.log('\n🎯 [CONTROLLER] PUT /configuracao-demanda/unidade/:unidadeId chamado');
    console.log('  - unidadeId:', unidadeId);
    console.log('  - updateDto:', JSON.stringify(updateDto, null, 2));
    console.log('  - userId:', req.user?.id);

    try {
      const userId = req.user?.id;
      const result = await this.configuracaoDemandaService.updateByUnidade(unidadeId, updateDto, userId);
      console.log('✅ [CONTROLLER] Resposta do service:', result);
      return result;
    } catch (error) {
      console.error('❌ [CONTROLLER] Erro ao processar PUT:', error.message);
      throw error;
    }
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateConfiguracaoDemandaDto,
    @Request() req: any,
  ) {
    console.log('\n🚨 [CONTROLLER] PUT /configuracao-demanda/:id chamado (ROTA GENÉRICA)');
    console.log('  - id recebido:', id);
    console.log('  - id parece ser unidadeId?:', id.startsWith('cmh'));
    console.log('  - updateDto:', JSON.stringify(updateDto, null, 2));

    const userId = req.user?.id;
    return this.configuracaoDemandaService.update(id, updateDto, userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    return this.configuracaoDemandaService.remove(id);
  }
}
