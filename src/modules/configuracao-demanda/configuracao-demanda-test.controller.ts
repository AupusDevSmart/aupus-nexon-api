import { Controller, Get } from '@nestjs/common';

@Controller('configuracao-demanda-test')
export class ConfiguracaoDemandaTestController {
  @Get()
  test() {
    return {
      message: 'Test controller works!',
      timestamp: new Date().toISOString(),
    };
  }
}
