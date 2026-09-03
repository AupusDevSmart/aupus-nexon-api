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
import { RolesService } from './roles.service';
import { RoleResponseDto } from './dto';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas as roles' })
  @ApiResponse({ 
    status: 200, 
    description: 'Lista de roles retornada com sucesso',
    type: [RoleResponseDto]
  })
  async findAll(): Promise<RoleResponseDto[]> {
    return this.rolesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar role por ID' })
  @ApiParam({ name: 'id', description: 'ID da role' })
  @ApiResponse({ 
    status: 200, 
    description: 'Role encontrada',
    type: RoleResponseDto
  })
  @ApiResponse({ 
    status: 404, 
    description: 'Role não encontrada' 
  })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<RoleResponseDto> {
    const role = await this.rolesService.findOne(id);
    
    if (!role) {
      throw new NotFoundException(`Role com ID ${id} não encontrada`);
    }
    
    return role;
  }
}