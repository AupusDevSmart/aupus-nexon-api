import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Payload de POST /equipamentos/:id/cmd/wifi — configura as redes WiFi de um TON
 * EM RUNTIME (sem reflash), publicando em <topico_mqtt>/cmd/wifi.
 *
 * O firmware multi-WiFi mantem ate 4 redes no NVS e cicla entre elas quando a
 * atual cai. Fire-and-forget (o firmware nao envia ack neste topico): o TON
 * precisa estar ONLINE (ainda na WiFi/Ethernet atual) quando o comando chega.
 * Caso de uso: pre-cadastrar a rede/senha NOVA a distancia ANTES da troca; quando
 * a antiga cair, o TON conecta sozinho na nova (depois da uma remove na antiga).
 */
export class ConfigurarWifiDto {
  @ApiProperty({
    enum: ['add', 'remove', 'list'],
    description:
      "'add' adiciona a rede (ou atualiza a senha se o SSID ja existir); " +
      "'remove' apaga a rede pelo SSID; 'list' apenas loga a lista no Serial do TON.",
  })
  @IsIn(['add', 'remove', 'list'])
  action!: 'add' | 'remove' | 'list';

  @ApiPropertyOptional({
    description: 'SSID da rede (obrigatorio para add e remove). Max 32 chars.',
  })
  @ValidateIf((o) => o.action === 'add' || o.action === 'remove')
  @IsString()
  @MaxLength(32, { message: 'ssid max 32 chars' })
  ssid?: string;

  @ApiPropertyOptional({
    description: 'Senha WPA (apenas para add; vazio = rede aberta). Max 64 chars.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'pass max 64 chars' })
  pass?: string;
}
