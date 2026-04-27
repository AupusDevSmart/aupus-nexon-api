import './instrument';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as Sentry from '@sentry/nestjs';
import logger from './config/logger.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    bufferLogs: true,
  });

  // Servir arquivos estáticos (uploads)
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  // CORS: origens permitidas em CORS_ORIGIN (separadas por virgula). Vazio = reflete qualquer origem (dev).
  const corsOriginEnv = process.env.CORS_ORIGIN?.trim();
  const corsOrigin = corsOriginEnv
    ? corsOriginEnv.split(',').map((o) => o.trim()).filter(Boolean)
    : true;
  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-xsrf-token'],
    credentials: true,
  });

  // ✅ Prefix global da API
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ✅ Interceptors (ordem importa!)
  app.useGlobalInterceptors(new LoggingInterceptor()); // Primeiro: logging
  app.useGlobalInterceptors(new ResponseInterceptor()); // Segundo: formatação de resposta

  // ✅ Aplicar filtro de exceções global
  app.useGlobalFilters(new HttpExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Sistema de Manutenção Industrial API')
    .setDescription('API completa para gestão de usuários, plantas, equipamentos e manutenção')
    .setVersion('1.0')
    .addTag('Sistema', 'Endpoints do sistema')
    .addTag('Usuários', 'Gestão de usuários')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);

  // Usar Pino logger para mensagens de inicialização
  logger.info(`🚀 API rodando em: http://localhost:${port}`);
  logger.info(`📖 Swagger docs: http://localhost:${port}/api/docs`);
  logger.info(`🔍 Teste de banco: http://localhost:${port}/api/v1/test-db`);
  logger.info(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);

  if (process.env.SENTRY_DSN) {
    logger.info('✅ Sentry ativo - Monitoramento de erros habilitado');
  } else {
    logger.warn('⚠️  Sentry não configurado - Defina SENTRY_DSN no .env');
  }
}

bootstrap().catch((error) => {
  logger.error({ error }, 'Erro fatal ao iniciar aplicação');
  Sentry.captureException(error);
  process.exit(1);
});