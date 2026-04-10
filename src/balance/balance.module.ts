import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceController } from './balance.controller.js';
import { BalanceService } from './balance.service.js';
import { TimeOffBalance } from './entities/balance.entity.js';
import { HcmModule } from '../hcm/hcm.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffBalance]), HcmModule],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
