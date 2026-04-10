import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncLog, SyncStatus, SyncType } from './entities/sync-log.entity.js';
import { BalanceService } from '../balance/balance.service.js';
import { HcmService } from '../hcm/hcm.service.js';
import { BatchSyncDto } from '../common/dto/batch-sync.dto.js';
import { TimeOffBalance } from '../balance/entities/balance.entity.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  private static readonly SYNC_LOG_RETENTION_DAYS = 90;

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
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

  /**
   * Scheduled: Every hour, sync stale balances from HCM.
   * A balance is "stale" if it hasn't been synced in the last hour.
   * This catches external balance changes (anniversary bonuses, annual resets).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledBatchRefresh(): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const staleBalances = await this.balanceRepo
      .createQueryBuilder('b')
      .select(['b.employeeId', 'b.locationId'])
      .where('b.lastSyncedAt < :cutoff OR b.lastSyncedAt IS NULL', {
        cutoff: oneHourAgo.toISOString(),
      })
      .groupBy('b.employeeId, b.locationId')
      .getRawMany<{ b_employee_id: string; b_location_id: string }>();

    if (staleBalances.length === 0) {
      return;
    }

    this.logger.log(
      `Scheduled refresh: syncing ${staleBalances.length} stale employee-location pairs`,
    );

    for (const row of staleBalances) {
      try {
        await this.balanceService.syncFromHcm(
          row.b_employee_id,
          row.b_location_id,
        );
      } catch (error) {
        this.logger.error(
          `Scheduled sync failed for employee=${row.b_employee_id}, location=${row.b_location_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Scheduled: Every day at midnight, delete sync logs older than 90 days.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldSyncLogs(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(
      cutoffDate.getDate() - SyncService.SYNC_LOG_RETENTION_DAYS,
    );

    const result = await this.syncLogRepo.delete({
      startedAt: LessThan(cutoffDate),
    });

    const deleted = result.affected || 0;
    if (deleted > 0) {
      this.logger.log(
        `Cleanup: deleted ${deleted} sync log(s) older than ${SyncService.SYNC_LOG_RETENTION_DAYS} days`,
      );
    }

    return deleted;
  }
}
