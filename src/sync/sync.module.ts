import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncLog } from './entities/sync-log.entity.js';
import { BalanceModule } from '../balance/balance.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([SyncLog]), BalanceModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
