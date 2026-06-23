import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsObject,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Dispara um OTA para um equipamento que já tem um firmware publicado.
 * Usado quando o .bin já está em /iot-compile/artifacts/.
 */
export class TriggerOtaDto {
  @ApiProperty({
    description: 'URL HTTP(S) do firmware.bin. Deve ser acessível pela TON.',
    example:
      'https://staging-nexon.aupusenergia.com.br/iot-compile/artifacts/TON1-1.0.1-1712345678.bin',
  })
  @IsUrl({ require_protocol: true })
  url!: string;

  @ApiProperty({
    description: 'Versão alvo do firmware. A TON ignora o comando se já está nesta versão.',
    example: '1.0.1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.+-]+$/, {
    message: 'version deve conter apenas [a-zA-Z0-9_.+-]',
  })
  version!: string;

  @ApiPropertyOptional({
    description: 'MD5 hex do .bin (32 caracteres). Recomendado — evita gravação corrompida.',
    example: 'a3b1c2d4e5f6071829304152637485a6',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{32}$/i, { message: 'md5 deve ser 32 hex chars' })
  md5?: string;

  @ApiPropertyOptional({
    description:
      'MAC do TON alvo (AA:BB:CC:DD:EE:FF). Se presente, firmwares com a verificacao ' +
      'instalada (ota_safety >= v2) so aplicam se o MAC bater. Defesa contra OTA acidental ' +
      'em TON errado quando varios TONs compartilham o mesmo topico no broker.',
    example: '98:A3:16:EB:2E:3C',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/, {
    message: 'target_mac deve ser MAC EUI-48 (AA:BB:CC:DD:EE:FF)',
  })
  target_mac?: string;
}

/**
 * Compila o firmware e dispara OTA em uma operação só.
 * Usado pelo botão "Publicar OTA" no NexOn.
 */
export class CompilePublishOtaDto {
  @ApiProperty({
    description: 'Mapa de arquivos do projeto PlatformIO (path -> conteúdo).',
    example: {
      'platformio.ini': '[env:ton]\nplatform = espressif32\n...',
      'src/main.cpp': '#include <Arduino.h>\n...',
    },
  })
  @IsObject()
  @IsNotEmpty()
  files!: Record<string, string>;

  @ApiProperty({ description: 'Nome do projeto (usado no filename do artefato)', example: 'TON1-PlantaGO' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'Versão a marcar no artefato', example: '1.0.1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.+-]+$/)
  version!: string;

  @ApiPropertyOptional({
    description: 'MAC do TON alvo (opcional). Propagado pro payload OTA.',
    example: '98:A3:16:EB:2E:3C',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/)
  target_mac?: string;
}

export class OtaStatusResponseDto {
  @ApiProperty({ example: true }) published!: boolean;
  @ApiProperty({ example: 'AUPUS/GO/PlantaX/InstA/TON1/ota/cmd' }) topic!: string;
  @ApiProperty({ example: 'https://.../TON1-1.0.1-1712345678.bin' }) url!: string;
  @ApiProperty({ example: '1.0.1' }) version!: string;
  @ApiProperty({ example: 'a3b1c2...' }) md5!: string;
  @ApiProperty({ example: 189234 }) size!: number;
}
