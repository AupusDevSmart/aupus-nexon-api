import { PartialType } from '@nestjs/mapped-types';
import { CreateIotDeviceTipoDto } from './create-iot-device-tipo.dto';

export class UpdateIotDeviceTipoDto extends PartialType(CreateIotDeviceTipoDto) {}
