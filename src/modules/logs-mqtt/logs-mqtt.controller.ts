import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CurrentUser } from '@/core';
import { LogsMqttService } from './logs-mqtt.service';
import { QueryLogsMqttDto, SilenciarLogDto } from './dto/query-logs-mqtt.dto';

@Controller('logs-mqtt')
export class LogsMqttController {
  constructor(private readonly service: LogsMqttService) {}

  /**
   * Trilha: `tipo` (csv alerta,comando,acesso), `status` (ativo|reconhecido|resolvido),
   * `plantaId`, `usuarioId`, além dos filtros de sempre. Resposta `{data, pagination}`.
   */
  @Get()
  findAll(@Query() query: QueryLogsMqttDto, @CurrentUser() user?: any) {
    return this.service.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.findOne(id, user);
  }

  @Post(':id/reconhecer')
  reconhecer(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.reconhecer(id, user);
  }

  @Post(':id/resolver')
  @HttpCode(HttpStatus.OK)
  resolver(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.resolver(id, user);
  }

  @Post(':id/silenciar')
  @HttpCode(HttpStatus.OK)
  silenciar(@Param('id') id: string, @Body() dto: SilenciarLogDto, @CurrentUser() user?: any) {
    return this.service.silenciar(id, dto.horas, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.remove(id, user);
  }
}
