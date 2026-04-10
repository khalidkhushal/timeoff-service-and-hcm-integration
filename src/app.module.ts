import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BalanceModule } from './balance/balance.module.js';
import { RequestModule } from './request/request.module.js';
import { SyncModule } from './sync/sync.module.js';
import { HcmModule } from './hcm/hcm.module.js';
import { TimeOffBalance } from './balance/entities/balance.entity.js';
import { TimeOffRequest } from './request/entities/time-off-request.entity.js';
import { SyncLog } from './sync/entities/sync-log.entity.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env['DB_PATH'] || 'time-off.db',
      entities: [TimeOffBalance, TimeOffRequest, SyncLog],
      synchronize: true,
    }),
    ScheduleModule.forRoot(),
    BalanceModule,
    RequestModule,
    SyncModule,
    HcmModule,
  ],
})
export class AppModule {}
