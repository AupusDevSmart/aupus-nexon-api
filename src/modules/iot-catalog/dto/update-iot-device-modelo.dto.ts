import { PartialType } from '@nestjs/mapped-types';
import { CreateIotDeviceModeloDto } from './create-iot-device-modelo.dto';

export class UpdateIotDeviceModeloDto extends PartialType(CreateIotDeviceModeloDto) {}
