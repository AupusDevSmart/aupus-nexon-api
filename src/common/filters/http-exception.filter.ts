import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SentryExceptionCaptured } from '@sentry/nestjs';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  @SentryExceptionCaptured()
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const requestId = uuidv4();
    const timestamp = new Date().toISOString();

    // Extrair mensagem e detalhes do erro
    let message = exception.message;
    let details: any = undefined;

    if (typeof exceptionResponse === 'object') {
      const responseObj = exceptionResponse as any;
      message = responseObj.message || message;

      // Se há array de mensagens de validação
      if (Array.isArray(responseObj.message)) {
        details = responseObj.message.map((msg: string | object) => {
          if (typeof msg === 'string') {
            return { message: msg };
          }
          return msg;
        });
      }
    }

    response.status(status).json({
      success: false,
      error: {
        code: this.getErrorCode(status),
        message,
        details,
      },
      meta: {
        timestamp,
        requestId,
      },
    });
  }

  private getErrorCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'INTERNAL_SERVER_ERROR';
      default:
        return 'ERROR';
    }
  }
}
