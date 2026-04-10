import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { BalanceService } from './balance.service.js';

@Controller('api/v1/balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId')
  async getBalances(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId?: string,
    @Query('leaveType') leaveType?: string,
    @Query('refresh') refresh?: string,
  ) {
    const shouldRefresh = refresh === 'true';
    const balances = await this.balanceService.getBalances(
      employeeId,
      locationId,
      leaveType,
      shouldRefresh,
    );

    return {
      employeeId,
      balances: balances.map((b) => ({
        locationId: b.locationId,
        leaveType: b.leaveType,
        totalBalance: Number(b.balance),
        pendingDeductions: Number(b.pendingDeductions),
        availableBalance: Number(b.balance) - Number(b.pendingDeductions),
        lastSyncedAt: b.lastSyncedAt,
      })),
    };
  }
}
