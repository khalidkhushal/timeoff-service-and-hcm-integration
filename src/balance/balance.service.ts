import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffBalance } from './entities/balance.entity.js';
import { HcmService } from '../hcm/hcm.service.js';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    private readonly hcmService: HcmService,
  ) {}

  async getBalances(
    employeeId: string,
    locationId?: string,
    leaveType?: string,
    refresh = false,
  ): Promise<TimeOffBalance[]> {
    if (refresh && locationId) {
      await this.syncFromHcm(employeeId, locationId, leaveType);
    }

    const where: Record<string, string> = { employeeId };
    if (locationId) where['locationId'] = locationId;
    if (leaveType) where['leaveType'] = leaveType;

    return this.balanceRepo.find({ where });
  }

  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): Promise<TimeOffBalance | null> {
    return this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });
  }

  async syncFromHcm(
    employeeId: string,
    locationId: string,
    leaveType?: string,
  ): Promise<TimeOffBalance[]> {
    const hcmBalances = await this.hcmService.getBalance(
      employeeId,
      locationId,
      leaveType,
    );

    const results: TimeOffBalance[] = [];

    for (const hcmBalance of hcmBalances) {
      const existing = await this.balanceRepo.findOne({
        where: {
          employeeId: hcmBalance.employeeId,
          locationId: hcmBalance.locationId,
          leaveType: hcmBalance.leaveType,
        },
      });

      if (existing) {
        existing.balance = hcmBalance.balance;
        existing.lastSyncedAt = new Date();
        const saved = await this.balanceRepo.save(existing);
        results.push(saved);
      } else {
        const newBalance = this.balanceRepo.create({
          employeeId: hcmBalance.employeeId,
          locationId: hcmBalance.locationId,
          leaveType: hcmBalance.leaveType,
          balance: hcmBalance.balance,
          pendingDeductions: 0,
          lastSyncedAt: new Date(),
        });
        const saved = await this.balanceRepo.save(newBalance);
        results.push(saved);
      }
    }

    this.logger.log(
      `Synced ${results.length} balance(s) from HCM for employee=${employeeId}, location=${locationId}`,
    );

    return results;
  }

  async upsertFromBatch(
    employeeId: string,
    locationId: string,
    leaveType: string,
    newBalance: number,
  ): Promise<TimeOffBalance> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (existing) {
      existing.balance = newBalance;
      existing.lastSyncedAt = new Date();
      // Preserve pending_deductions — these represent in-flight approved requests
      return this.balanceRepo.save(existing);
    }

    const balance = this.balanceRepo.create({
      employeeId,
      locationId,
      leaveType,
      balance: newBalance,
      pendingDeductions: 0,
      lastSyncedAt: new Date(),
    });
    return this.balanceRepo.save(balance);
  }

  async addPendingDeduction(
    employeeId: string,
    locationId: string,
    leaveType: string,
    days: number,
  ): Promise<TimeOffBalance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance found for employee=${employeeId}, location=${locationId}, type=${leaveType}`,
      );
    }

    const available = Number(balance.balance) - Number(balance.pendingDeductions);
    if (available < days) {
      throw new Error(
        `Insufficient balance: available=${available}, requested=${days}`,
      );
    }

    balance.pendingDeductions = Number(balance.pendingDeductions) + days;
    return this.balanceRepo.save(balance);
  }

  async removePendingDeduction(
    employeeId: string,
    locationId: string,
    leaveType: string,
    days: number,
  ): Promise<TimeOffBalance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance found for employee=${employeeId}, location=${locationId}, type=${leaveType}`,
      );
    }

    balance.pendingDeductions = Math.max(
      0,
      Number(balance.pendingDeductions) - days,
    );
    return this.balanceRepo.save(balance);
  }

  async confirmDeduction(
    employeeId: string,
    locationId: string,
    leaveType: string,
    days: number,
  ): Promise<TimeOffBalance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance found for employee=${employeeId}, location=${locationId}, type=${leaveType}`,
      );
    }

    // HCM confirmed the deduction, so:
    // 1. Decrease the actual balance
    // 2. Remove from pending deductions
    balance.balance = Number(balance.balance) - days;
    balance.pendingDeductions = Math.max(
      0,
      Number(balance.pendingDeductions) - days,
    );
    return this.balanceRepo.save(balance);
  }
}
