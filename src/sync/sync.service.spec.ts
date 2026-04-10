import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncService } from './sync.service.js';
import { SyncLog, SyncStatus, SyncType } from './entities/sync-log.entity.js';
import { BalanceService } from '../balance/balance.service.js';

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: jest.Mocked<Repository<SyncLog>>;
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        {
          provide: getRepositoryToken(SyncLog),
          useValue: {
            find: jest.fn(),
            create: jest.fn().mockImplementation((partial) => ({ ...mockSyncLog, ...partial })),
            save: jest.fn().mockImplementation(async (entity) => entity),
          },
        },
        {
          provide: BalanceService,
          useValue: {
            upsertFromBatch: jest.fn(),
            syncFromHcm: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    syncLogRepo = module.get(getRepositoryToken(SyncLog));
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
});
