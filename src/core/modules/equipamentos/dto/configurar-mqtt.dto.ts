import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, MaxLength } from 'class-validator';

export class ConfigurarMqttDto {
  @ApiProperty({
    description: 'Tópico MQTT para receber dados do equipamento',
    example: 'usina/ufv-principal/inversor-01',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  topico_mqtt: string;

  @ApiProperty({
    description: 'Se o MQTT está habilitado para este equipamento',
    example: true,
  })
  @IsBoolean()
  mqtt_habilitado: boolean;
}

export class DesabilitarMqttDto {
  @ApiPropertyOptional({
    description: 'Se o MQTT está habilitado para este equipamento',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  mqtt_habilitado?: boolean;
}
