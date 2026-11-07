import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ChamadosModule } from '../chamados/chamados.module';
import { EquipamentosCmdModule } from '../equipamentos-cmd/equipamentos-cmd.module';
import { CamerasAgenteController } from './cameras-agente.controller';
import { CamerasAgenteService } from './cameras-agente.service';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasConfigService } from './cameras-config.service';
import { CamerasEventosService } from './cameras-eventos.service';
import { CamerasMidiaController } from './cameras-midia.controller';
import { CamerasMidiaService } from './cameras-midia.service';
import { CamerasNotificacaoService } from './cameras-notificacao.service';
import { CamerasOfflineWorker } from './cameras-offline.worker';
import { CamerasStorageService } from './cameras-storage.service';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { CameraAgenteGuard } from './guards/camera-agente.guard';
import { UsuarioOuTokenMidiaGuard } from './guards/usuario-ou-token-midia.guard';

/**
 * Câmeras IP do NexON (NEXON-88): cadastro por instalação, agente local (nexon-camera-agent),
 * eventos de detecção, armamento, refletor/sirene (EquipamentosCmd), chamado automático
 * (Chamados), vídeo via MediaMTX. Contrato em NexON/docs/cameras/API-CAMERAS.md;
 * tabelas em db/manual-migrations/2026-11-07_cameras.sql.
 */
@Module({
  imports: [PrismaModule, EquipamentosCmdModule, ChamadosModule],
  controllers: [CamerasAgenteController, CamerasMidiaController, CamerasController],
  providers: [
    CamerasService,
    CamerasEventosService,
    CamerasAgenteService,
    CamerasMidiaService,
    CamerasNotificacaoService,
    CamerasStorageService,
    CamerasConfigService,
    CamerasAuditoriaService,
    CamerasOfflineWorker,
    CameraAgenteGuard,
    UsuarioOuTokenMidiaGuard,
  ],
  exports: [CamerasMidiaService],
})
export class CamerasModule {}
