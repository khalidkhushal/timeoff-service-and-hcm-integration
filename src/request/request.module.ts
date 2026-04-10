import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestController } from './request.controller.js';
import { RequestService } from './request.service.js';
import { TimeOffRequest } from './entities/time-off-request.entity.js';
import { BalanceModule } from '../balance/balance.module.js';
import { HcmModule } from '../hcm/hcm.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalanceModule,
    HcmModule,
  ],
  controllers: [RequestController],
  providers: [RequestService],
  exports: [RequestService],
})
export class RequestModule {}
