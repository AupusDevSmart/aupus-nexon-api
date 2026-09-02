import { Injectable, PipeTransform, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseULIDPipe implements PipeTransform {
  transform(value: any): string {
    if (!value || typeof value !== 'string') {
      throw new BadRequestException('Invalid ID format');
    }

    // Accept any string ID (ULID, CUID, UUID, etc.) - just validate it's a non-empty string
    if (value.length < 10 || value.length > 50) {
      throw new BadRequestException('Invalid ID format');
    }

    return value;
  }
}