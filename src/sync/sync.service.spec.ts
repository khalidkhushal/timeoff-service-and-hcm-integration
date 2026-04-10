import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncService } from './sync.service.js';
import { SyncLog, SyncStatus, SyncType } from './entities/sync-log.entity.js';
import { TimeOffBalance } from '../balance/entities/balance.entity.js';
import { BalanceService } from '../balance/balance.service.js';
import { HcmService } from '../hcm/hcm.service.js';

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: jest.Mocked<Repository<SyncLog>>;
  let balanceRepo: jest.Mocked<Repository<TimeOffBalance>>;
  let balanceService: jest.Mocked<BalanceService>;

  const mockSyncLog: SyncLog = {
    id: 1,
    syncType: SyncType.BATCH,
    status: SyncStatus.SUCCESS,
    recordsProcessed: 0,
    recordsFailed: 0,
    errorDetails: null,
    startedAt: new Date(),
    completedAt: null,
  };

  beforeEach(async () => {
    const mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        {
          provide: getRepositoryToken(SyncLog),
          useValue: {
            find: jest.fn(),
            create: jest.fn().mockImplementation((partial) => ({ ...mockSyncLog, ...partial })),
            save: jest.fn().mockImplementation(async (entity) => entity),
            delete: jest.fn().mockResolvedValue({ affected: 0 }),
          },
        },
        {
          provide: getRepositoryToken(TimeOffBalance),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
        {
          provide: BalanceService,
          useValue: {
            upsertFromBatch: jest.fn(),
            syncFromHcm: jest.fn(),
          },
        },
        {
          provide: HcmService,
          useValue: {
            getBalance: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    syncLogRepo = module.get(getRepositoryToken(SyncLog));
    balanceRepo = module.get(getRepositoryToken(TimeOffBalance));
    balanceService = module.get(BalanceService);
  });

  describe('processBatchSync', () => {
    it('should process all balances successfully', async () => {
      balanceService.upsertFromBatch.mockResolvedValue({} as any);

      const result = await service.processBatchSync({
        balances: [
          { employeeId: 'emp-1', locationId: 'loc-1', leaveType: 'vacation', balance: 10 },
          { employeeId: 'emp-2', locationId: 'loc-1', leaveType: 'vacation', balance: 15 },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(result.recordsProcessed).toBe(2);
      expect(result.recordsFailed).toBe(0);
      expect(result.status).toBe(SyncStatus.SUCCESS);
    });

    it('should handle partial failures', async () => {
      balanceService.upsertFromBatch
        .mockResolvedValueOnce({} as any)
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await service.processBatchSync({
        balances: [
          { employeeId: 'emp-1', locationId: 'loc-1', leaveType: 'vacation', balance: 10 },
          { employeeId: 'emp-2', locationId: 'loc-1', leaveType: 'vacation', balance: 15 },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(result.recordsProcessed).toBe(1);
      expect(result.recordsFailed).toBe(1);
      expect(result.status).toBe(SyncStatus.PARTIAL);
      expect(result.errorDetails).toBeTruthy();
    });

    it('should mark as FAILED when all records fail', async () => {
      balanceService.upsertFromBatch.mockRejectedValue(new Error('DB error'));

      const result = await service.processBatchSync({
        balances: [
          { employeeId: 'emp-1', locationId: 'loc-1', leaveType: 'vacation', balance: 10 },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(result.recordsProcessed).toBe(0);
      expect(result.recordsFailed).toBe(1);
      expect(result.status).toBe(SyncStatus.FAILED);
    });

    it('should handle empty batch', async () => {
      const result = await service.processBatchSync({
        balances: [],
        timestamp: new Date().toISOString(),
      });

      expect(result.recordsProcessed).toBe(0);
      expect(result.recordsFailed).toBe(0);
      expect(result.status).toBe(SyncStatus.SUCCESS);
    });
  });

  describe('triggerRealtimeSync', () => {
    it('should sync successfully from HCM', async () => {
      balanceService.syncFromHcm.mockResolvedValue([{} as any, {} as any]);

      const result = await service.triggerRealtimeSync('emp-1', 'loc-1');
      expect(result.syncType).toBe(SyncType.REALTIME);
      expect(result.recordsProcessed).toBe(2);
      expect(result.status).toBe(SyncStatus.SUCCESS);
    });

    it('should handle HCM failure', async () => {
      balanceService.syncFromHcm.mockRejectedValue(new Error('HCM unavailable'));

      const result = await service.triggerRealtimeSync('emp-1', 'loc-1');
      expect(result.status).toBe(SyncStatus.FAILED);
      expect(result.errorDetails).toBe('HCM unavailable');
    });
  });

  describe('getSyncLogs', () => {
    it('should return sync logs ordered by date', async () => {
      syncLogRepo.find.mockResolvedValue([mockSyncLog]);

      const result = await service.getSyncLogs(10);
      expect(result).toHaveLength(1);
      expect(syncLogRepo.find).toHaveBeenCalledWith({
        order: { startedAt: 'DESC' },
        take: 10,
      });
    });
  });

  describe('scheduledBatchRefresh', () => {
    it('should skip when no stale balances exist', async () => {
      const qb = balanceRepo.createQueryBuilder('b');
      (qb.getRawMany as jest.Mock).mockResolvedValue([]);

      await service.scheduledBatchRefresh();
      expect(balanceService.syncFromHcm).not.toHaveBeenCalled();
    });

    it('should sync stale employee-location pairs', async () => {
      const qb = balanceRepo.createQueryBuilder('b');
      (qb.getRawMany as jest.Mock).mockResolvedValue([
        { b_employee_id: 'emp-1', b_location_id: 'loc-1' },
        { b_employee_id: 'emp-2', b_location_id: 'loc-2' },
      ]);
      balanceService.syncFromHcm.mockResolvedValue([]);

      await service.scheduledBatchRefresh();
      expect(balanceService.syncFromHcm).toHaveBeenCalledTimes(2);
      expect(balanceService.syncFromHcm).toHaveBeenCalledWith('emp-1', 'loc-1');
      expect(balanceService.syncFromHcm).toHaveBeenCalledWith('emp-2', 'loc-2');
    });

    it('should continue syncing other pairs when one fails', async () => {
      const qb = balanceRepo.createQueryBuilder('b');
      (qb.getRawMany as jest.Mock).mockResolvedValue([
        { b_employee_id: 'emp-1', b_location_id: 'loc-1' },
        { b_employee_id: 'emp-2', b_location_id: 'loc-2' },
      ]);
      balanceService.syncFromHcm
        .mockRejectedValueOnce(new Error('HCM down'))
        .mockResolvedValueOnce([]);

      await service.scheduledBatchRefresh();
      expect(balanceService.syncFromHcm).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanupOldSyncLogs', () => {
    it('should delete logs older than 90 days', async () => {
      syncLogRepo.delete.mockResolvedValue({ affected: 5, raw: {} });

      const deleted = await service.cleanupOldSyncLogs();
      expect(deleted).toBe(5);
      expect(syncLogRepo.delete).toHaveBeenCalled();
    });

    it('should return 0 when no old logs exist', async () => {
      syncLogRepo.delete.mockResolvedValue({ affected: 0, raw: {} });

      const deleted = await service.cleanupOldSyncLogs();
      expect(deleted).toBe(0);
    });
  });
});
