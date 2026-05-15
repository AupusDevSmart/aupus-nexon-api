import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CurrentUser } from '@aupus/api-shared';
import { LogsMqttService } from './logs-mqtt.service';
import { QueryLogsMqttDto } from './dto/query-logs-mqtt.dto';

@Controller('logs-mqtt')
export class LogsMqttController {
  constructor(private readonly service: LogsMqttService) {}

  @Get()
  findAll(@Query() query: QueryLogsMqttDto, @CurrentUser() user?: any) {
    return this.service.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.findOne(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.remove(id, user);
  }
}
