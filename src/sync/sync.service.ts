import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncLog, SyncStatus, SyncType } from './entities/sync-log.entity.js';
import { BalanceService } from '../balance/balance.service.js';
import { BatchSyncDto } from '../common/dto/batch-sync.dto.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly balanceService: BalanceService,
  ) {}

  async processBatchSync(dto: BatchSyncDto): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      syncType: SyncType.BATCH,
      status: SyncStatus.SUCCESS,
      recordsProcessed: 0,
      recordsFailed: 0,
    });
    await this.syncLogRepo.save(syncLog);

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of dto.balances) {
      try {
        await this.balanceService.upsertFromBatch(
          item.employeeId,
          item.locationId,
          item.leaveType,
          item.balance,
        );
        processed++;
      } catch (error) {
        failed++;
        const msg = `Failed to sync balance for employee=${item.employeeId}, location=${item.locationId}, type=${item.leaveType}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(msg);
        this.logger.error(msg);
      }
    }

    syncLog.recordsProcessed = processed;
    syncLog.recordsFailed = failed;
    syncLog.completedAt = new Date();

    if (failed === 0) {
      syncLog.status = SyncStatus.SUCCESS;
    } else if (processed > 0) {
      syncLog.status = SyncStatus.PARTIAL;
    } else {
      syncLog.status = SyncStatus.FAILED;
    }

    if (errors.length > 0) {
      syncLog.errorDetails = JSON.stringify(errors);
    }

    await this.syncLogRepo.save(syncLog);

    this.logger.log(
      `Batch sync completed: processed=${processed}, failed=${failed}, status=${syncLog.status}`,
    );

    return syncLog;
  }

  async triggerRealtimeSync(
    employeeId: string,
    locationId: string,
  ): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      syncType: SyncType.REALTIME,
      status: SyncStatus.SUCCESS,
    });
    await this.syncLogRepo.save(syncLog);

    try {
      const balances = await this.balanceService.syncFromHcm(
        employeeId,
        locationId,
      );
      syncLog.recordsProcessed = balances.length;
      syncLog.recordsFailed = 0;
      syncLog.status = SyncStatus.SUCCESS;
      syncLog.completedAt = new Date();
    } catch (error) {
      syncLog.recordsProcessed = 0;
      syncLog.recordsFailed = 1;
      syncLog.status = SyncStatus.FAILED;
      syncLog.errorDetails =
        error instanceof Error ? error.message : String(error);
      syncLog.completedAt = new Date();
    }

    await this.syncLogRepo.save(syncLog);
    return syncLog;
  }

  async getSyncLogs(limit = 50): Promise<SyncLog[]> {
    return this.syncLogRepo.find({
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }
}
