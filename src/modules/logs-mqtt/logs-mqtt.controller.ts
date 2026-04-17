import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LogsMqttService } from './logs-mqtt.service';
import { QueryLogsMqttDto } from './dto/query-logs-mqtt.dto';

@Controller('logs-mqtt')
export class LogsMqttController {
  constructor(private readonly service: LogsMqttService) {}

  @Get()
  findAll(@Query() query: QueryLogsMqttDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
