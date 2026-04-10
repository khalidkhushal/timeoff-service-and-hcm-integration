import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { BalanceService } from './balance.service.js';
import { TimeOffBalance } from './entities/balance.entity.js';
import { HcmService } from '../hcm/hcm.service.js';

describe('BalanceService', () => {
  let service: BalanceService;
  let repo: jest.Mocked<Repository<TimeOffBalance>>;
  let hcmService: jest.Mocked<HcmService>;

  const mockBalance: TimeOffBalance = {
    id: 1,
    employeeId: 'emp-1',
    locationId: 'loc-1',
    leaveType: 'vacation',
    balance: 10,
    pendingDeductions: 2,
    lastSyncedAt: new Date(),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    get availableBalance() {
      return Number(this.balance) - Number(this.pendingDeductions);
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        {
          provide: getRepositoryToken(TimeOffBalance),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: HcmService,
          useValue: {
            getBalance: jest.fn(),
            submitDeduction: jest.fn(),
            cancelDeduction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    repo = module.get(getRepositoryToken(TimeOffBalance));
    hcmService = module.get(HcmService);
  });

  describe('getBalances', () => {
    it('should return balances for an employee', async () => {
      repo.find.mockResolvedValue([mockBalance]);

      const result = await service.getBalances('emp-1');
      expect(result).toHaveLength(1);
      expect(result[0]!.employeeId).toBe('emp-1');
      expect(repo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
      });
    });

    it('should filter by locationId and leaveType', async () => {
      repo.find.mockResolvedValue([mockBalance]);

      await service.getBalances('emp-1', 'loc-1', 'vacation');
      expect(repo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1', locationId: 'loc-1', leaveType: 'vacation' },
      });
    });

    it('should sync from HCM when refresh is true and locationId provided', async () => {
      hcmService.getBalance.mockResolvedValue([
        {
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'vacation',
          balance: 15,
        },
      ]);
      repo.findOne.mockResolvedValue(mockBalance);
      repo.save.mockResolvedValue({ ...mockBalance, balance: 15 });
      repo.find.mockResolvedValue([{ ...mockBalance, balance: 15 }]);

      const result = await service.getBalances('emp-1', 'loc-1', undefined, true);
      expect(hcmService.getBalance).toHaveBeenCalledWith('emp-1', 'loc-1', undefined);
      expect(result).toHaveLength(1);
    });

    it('should NOT sync from HCM when refresh is true but locationId is missing', async () => {
      repo.find.mockResolvedValue([mockBalance]);

      await service.getBalances('emp-1', undefined, undefined, true);
      expect(hcmService.getBalance).not.toHaveBeenCalled();
    });
  });

  describe('getBalance', () => {
    it('should return a single balance', async () => {
      repo.findOne.mockResolvedValue(mockBalance);

      const result = await service.getBalance('emp-1', 'loc-1', 'vacation');
      expect(result).toEqual(mockBalance);
    });

    it('should return null when no balance found', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.getBalance('emp-1', 'loc-1', 'vacation');
      expect(result).toBeNull();
    });
  });

  describe('syncFromHcm', () => {
    it('should update existing balance from HCM', async () => {
      hcmService.getBalance.mockResolvedValue([
        {
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'vacation',
          balance: 20,
        },
      ]);
      repo.findOne.mockResolvedValue({ ...mockBalance });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.syncFromHcm('emp-1', 'loc-1');
      expect(result).toHaveLength(1);
      expect(result[0]!.balance).toBe(20);
      expect(result[0]!.lastSyncedAt).toBeInstanceOf(Date);
    });

    it('should create new balance if not exists locally', async () => {
      hcmService.getBalance.mockResolvedValue([
        {
          employeeId: 'emp-2',
          locationId: 'loc-1',
          leaveType: 'sick',
          balance: 5,
        },
      ]);
      repo.findOne.mockResolvedValue(null);
      const newBalance = {
        ...mockBalance,
        employeeId: 'emp-2',
        leaveType: 'sick',
        balance: 5,
        pendingDeductions: 0,
      };
      repo.create.mockReturnValue(newBalance);
      repo.save.mockResolvedValue(newBalance);

      const result = await service.syncFromHcm('emp-2', 'loc-1');
      expect(result).toHaveLength(1);
      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('upsertFromBatch', () => {
    it('should update existing balance preserving pending deductions', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, pendingDeductions: 3 });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.upsertFromBatch('emp-1', 'loc-1', 'vacation', 25);
      expect(result.balance).toBe(25);
      expect(result.pendingDeductions).toBe(3); // preserved
    });

    it('should create new balance for new employee/location combo', async () => {
      repo.findOne.mockResolvedValue(null);
      const newBalance = {
        ...mockBalance,
        balance: 12,
        pendingDeductions: 0,
      };
      repo.create.mockReturnValue(newBalance);
      repo.save.mockResolvedValue(newBalance);

      const result = await service.upsertFromBatch('emp-new', 'loc-1', 'vacation', 12);
      expect(result.balance).toBe(12);
      expect(result.pendingDeductions).toBe(0);
    });
  });

  describe('addPendingDeduction', () => {
    it('should add to pending deductions when sufficient balance', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, balance: 10, pendingDeductions: 0 });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.addPendingDeduction('emp-1', 'loc-1', 'vacation', 3);
      expect(result.pendingDeductions).toBe(3);
    });

    it('should throw NotFoundException when no balance record', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.addPendingDeduction('emp-1', 'loc-1', 'vacation', 3),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw Error when insufficient balance', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, balance: 5, pendingDeductions: 4 });

      await expect(
        service.addPendingDeduction('emp-1', 'loc-1', 'vacation', 3),
      ).rejects.toThrow('Insufficient balance');
    });
  });

  describe('removePendingDeduction', () => {
    it('should remove from pending deductions', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, pendingDeductions: 5 });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.removePendingDeduction('emp-1', 'loc-1', 'vacation', 3);
      expect(result.pendingDeductions).toBe(2);
    });

    it('should not go below zero', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, pendingDeductions: 1 });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.removePendingDeduction('emp-1', 'loc-1', 'vacation', 5);
      expect(result.pendingDeductions).toBe(0);
    });

    it('should throw NotFoundException when no balance record', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.removePendingDeduction('emp-1', 'loc-1', 'vacation', 3),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmDeduction', () => {
    it('should decrease balance and remove from pending', async () => {
      repo.findOne.mockResolvedValue({ ...mockBalance, balance: 10, pendingDeductions: 3 });
      repo.save.mockImplementation(async (entity) => entity as TimeOffBalance);

      const result = await service.confirmDeduction('emp-1', 'loc-1', 'vacation', 3);
      expect(result.balance).toBe(7);
      expect(result.pendingDeductions).toBe(0);
    });

    it('should throw NotFoundException when no balance record', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.confirmDeduction('emp-1', 'loc-1', 'vacation', 3),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
