import { 
  Controller, 
  Get, 
  Param, 
  ParseIntPipe,
  NotFoundException 
} from '@nestjs/common';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiParam 
} from '@nestjs/swagger';
import { PermissionsService } from './permissions.service';
import { PermissionResponseDto } from './dto';

@ApiTags('permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas as permissões' })
  @ApiResponse({ 
    status: 200, 
    description: 'Lista de permissões retornada com sucesso',
    type: [PermissionResponseDto]
  })
  async findAll(): Promise<PermissionResponseDto[]> {
    return this.permissionsService.findAll();
  }

  @Get('grouped')
  @ApiOperation({ summary: 'Listar permissões agrupadas por categoria' })
  @ApiResponse({ 
    status: 200, 
    description: 'Permissões agrupadas por categoria',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { $ref: '#/components/schemas/PermissionResponseDto' }
      }
    }
  })
  async findGrouped(): Promise<{ [category: string]: PermissionResponseDto[] }> {
    return this.permissionsService.findGrouped();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar permissão por ID' })
  @ApiParam({ name: 'id', description: 'ID da permissão' })
  @ApiResponse({ 
    status: 200, 
    description: 'Permissão encontrada',
    type: PermissionResponseDto
  })
  @ApiResponse({ 
    status: 404, 
    description: 'Permissão não encontrada' 
  })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<PermissionResponseDto> {
    const permission = await this.permissionsService.findOne(id);
    
    if (!permission) {
      throw new NotFoundException(`Permissão com ID ${id} não encontrada`);
    }
    
    return permission;
  }
}