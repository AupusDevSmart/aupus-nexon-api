import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RegrasLogsMqttService } from './regras-logs-mqtt.service';
import { CreateRegraLogDto } from './dto/create-regra-log.dto';
import { UpdateRegraLogDto } from './dto/update-regra-log.dto';
import { QueryRegrasLogsDto } from './dto/query-regras-logs.dto';

@Controller('regras-logs-mqtt')
export class RegrasLogsMqttController {
  constructor(private readonly service: RegrasLogsMqttService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRegraLogDto) {
    return this.service.create(dto);
  }

  @Get()
  findAll(@Query() query: QueryRegrasLogsDto) {
    return this.service.findAll(query);
  }

  @Get('campos/:equipamentoId')
  getCampos(@Param('equipamentoId') equipamentoId: string) {
    return this.service.getCamposEquipamento(equipamentoId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRegraLogDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
