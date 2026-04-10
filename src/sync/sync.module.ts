import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncLog } from './entities/sync-log.entity.js';
import { TimeOffBalance } from '../balance/entities/balance.entity.js';
import { BalanceModule } from '../balance/balance.module.js';
import { HcmModule } from '../hcm/hcm.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLog, TimeOffBalance]),
    BalanceModule,
    HcmModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
