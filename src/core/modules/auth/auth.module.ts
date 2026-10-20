import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AcessoNegadoInterceptor } from './acesso-negado';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessoesService } from './sessoes.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { PermissionScopeModule } from './permission-scope.module';

/**
 * Módulo de Autenticação
 * Gerencia login, JWT, guards e estratégias de autenticação
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') ||
          'your-secret-key-change-in-production',
        signOptions: {
          expiresIn: '1h', // Expiração padrão do access token
        },
      }),
    }),
    UsuariosModule,
    PermissionScopeModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessoesService,
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard, // Aplicar JwtAuthGuard globalmente
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard, // Valida @Permissions() globalmente (rotas sem decorator passam)
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AcessoNegadoInterceptor, // 403 de comando/cadastro vai para a auditoria (PER-43)
    },
  ],
  exports: [AuthService, SessoesService, JwtModule],
})
export class AuthModule {}
