import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '@/core';
import { Permissions } from '@/core/modules/auth/decorators/permissions.decorator';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { RegrasNotificacaoService } from './regras-notificacao.service';
import {
  CreateRegraNotificacaoDto,
  QueryRegrasNotificacaoDto,
  UpdateRegraNotificacaoDto,
} from './dto/regra-notificacao.dto';

/** NEXON-25 — Configurações › Notificações (regras). Mesma permissão de Usuários e Permissões. */
@Controller('regras-notificacao')
export class RegrasNotificacaoController {
  constructor(private readonly service: RegrasNotificacaoService) {}

  @Get()
  @Permissions('usuarios.manage')
  findAll(@Query() query: QueryRegrasNotificacaoDto, @CurrentUser() user?: any) {
    return this.service.findAll(query, user);
  }

  @Get(':id/destinatarios')
  @Permissions('usuarios.manage')
  destinatarios(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.destinatarios(id, user);
  }

  @Get(':id')
  @Permissions('usuarios.manage')
  findOne(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.findOne(id, user);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('usuarios.manage')
  create(@Body() dto: CreateRegraNotificacaoDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.service.create(dto, user, cliente);
  }

  @Put(':id')
  @Permissions('usuarios.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRegraNotificacaoDto,
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    return this.service.update(id, dto, user, cliente);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('usuarios.manage')
  remove(@Param('id') id: string, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.service.remove(id, user, cliente);
  }
}
