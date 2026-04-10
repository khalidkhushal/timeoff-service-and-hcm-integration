import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { RequestService } from './request.service.js';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from './entities/time-off-request.entity.js';
import { BalanceService } from '../balance/balance.service.js';
import { HcmService } from '../hcm/hcm.service.js';

describe('RequestService', () => {
  let service: RequestService;
  let repo: jest.Mocked<Repository<TimeOffRequest>>;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmService: jest.Mocked<HcmService>;

  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0]!;
  };

  const mockBalance = {
    id: 1,
    employeeId: 'emp-1',
    locationId: 'loc-1',
    leaveType: 'vacation',
    balance: 10,
    pendingDeductions: 0,
    lastSyncedAt: new Date(),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    get availableBalance() {
      return Number(this.balance) - Number(this.pendingDeductions);
    },
  };

  const mockRequest: TimeOffRequest = {
    id: 1,
    employeeId: 'emp-1',
    locationId: 'loc-1',
    leaveType: 'vacation',
    startDate: futureDate(),
    endDate: futureDate(),
    daysRequested: 2,
    status: TimeOffRequestStatus.PENDING,
    rejectionReason: null,
    hcmReferenceId: null,
    idempotencyKey: 'key-123',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestService,
        {
          provide: getRepositoryToken(TimeOffRequest),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: BalanceService,
          useValue: {
            getBalance: jest.fn(),
            addPendingDeduction: jest.fn(),
            removePendingDeduction: jest.fn(),
            confirmDeduction: jest.fn(),
          },
        },
        {
          provide: HcmService,
          useValue: {
            submitDeduction: jest.fn(),
            cancelDeduction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RequestService>(RequestService);
    repo = module.get(getRepositoryToken(TimeOffRequest));
    balanceService = module.get(BalanceService);
    hcmService = module.get(HcmService);
  });

  describe('create', () => {
    const createDto = {
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveType: 'vacation',
      startDate: '',
      endDate: '',
      daysRequested: 2,
      idempotencyKey: 'key-new',
    };

    beforeEach(() => {
      createDto.startDate = futureDate();
      createDto.endDate = futureDate();
    });

    it('should create a new time-off request', async () => {
      repo.findOne.mockResolvedValue(null); // no idempotent match
      balanceService.getBalance.mockResolvedValue(mockBalance as any);
      repo.create.mockReturnValue({ ...mockRequest, idempotencyKey: 'key-new' });
      repo.save.mockResolvedValue({ ...mockRequest, idempotencyKey: 'key-new' });

      const result = await service.create(createDto);
      expect(result.status).toBe(TimeOffRequestStatus.PENDING);
      expect(repo.create).toHaveBeenCalled();
    });

    it('should return existing request for duplicate idempotency key', async () => {
      repo.findOne.mockResolvedValue(mockRequest);

      const result = await service.create({
        ...createDto,
        idempotencyKey: 'key-123',
      });
      expect(result).toEqual(mockRequest);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('should reject start date in the past', async () => {
      repo.findOne.mockResolvedValue(null);
      const pastDate = '2020-01-01';

      await expect(
        service.create({ ...createDto, startDate: pastDate }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject end date before start date', async () => {
      repo.findOne.mockResolvedValue(null);
      const start = futureDate();
      const d = new Date(start);
      d.setDate(d.getDate() - 1);
      const end = d.toISOString().split('T')[0]!;

      await expect(
        service.create({ ...createDto, startDate: start, endDate: end }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when no balance record exists', async () => {
      repo.findOne.mockResolvedValue(null);
      balanceService.getBalance.mockResolvedValue(null);

      await expect(service.create(createDto)).rejects.toThrow(NotFoundException);
    });

    it('should reject when insufficient balance', async () => {
      repo.findOne.mockResolvedValue(null);
      balanceService.getBalance.mockResolvedValue({
        ...mockBalance,
        balance: 1,
        pendingDeductions: 0,
      } as any);

      await expect(service.create(createDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('should return a request by id', async () => {
      repo.findOne.mockResolvedValue(mockRequest);
      const result = await service.findOne(1);
      expect(result).toEqual(mockRequest);
    });

    it('should throw NotFoundException for unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return filtered requests', async () => {
      repo.find.mockResolvedValue([mockRequest]);

      const result = await service.findAll({ employeeId: 'emp-1' });
      expect(result).toHaveLength(1);
      expect(repo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
        order: { createdAt: 'DESC' },
      });
    });

    it('should filter by status', async () => {
      repo.find.mockResolvedValue([]);

      await service.findAll({ status: TimeOffRequestStatus.APPROVED });
      expect(repo.find).toHaveBeenCalledWith({
        where: { status: TimeOffRequestStatus.APPROVED },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('approve', () => {
    it('should approve a pending request and add pending deduction', async () => {
      const pendingRequest = { ...mockRequest, status: TimeOffRequestStatus.PENDING };
      repo.findOne.mockResolvedValue(pendingRequest);
      balanceService.getBalance.mockResolvedValue(mockBalance as any);
      balanceService.addPendingDeduction.mockResolvedValue(mockBalance as any);

      // Make HCM submission hang so the async fire-and-forget doesn't mutate before assertion
      hcmService.submitDeduction.mockReturnValue(new Promise(() => {}));

      const savedStatuses: string[] = [];
      repo.save.mockImplementation(async (entity) => {
        savedStatuses.push((entity as TimeOffRequest).status);
        return entity as TimeOffRequest;
      });

      const result = await service.approve(1);

      // The first save is with APPROVED status (before async HCM submission)
      expect(savedStatuses[0]).toBe(TimeOffRequestStatus.APPROVED);
      expect(balanceService.addPendingDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'vacation',
        2,
      );
    });

    it('should throw ConflictException for non-pending request', async () => {
      repo.findOne.mockResolvedValue({
        ...mockRequest,
        status: TimeOffRequestStatus.APPROVED,
      });

      await expect(service.approve(1)).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException when insufficient balance at approval', async () => {
      repo.findOne.mockResolvedValue({
        ...mockRequest,
        status: TimeOffRequestStatus.PENDING,
      });
      balanceService.getBalance.mockResolvedValue({
        ...mockBalance,
        balance: 1,
        pendingDeductions: 0,
      } as any);

      await expect(service.approve(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('submitToHcm', () => {
    it('should set status to CONFIRMED on HCM success', async () => {
      const request = { ...mockRequest, status: TimeOffRequestStatus.APPROVED };
      hcmService.submitDeduction.mockResolvedValue({
        success: true,
        referenceId: 'HCM-REF-123',
      });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);
      balanceService.confirmDeduction.mockResolvedValue(mockBalance as any);

      const result = await service.submitToHcm(request);
      expect(result.status).toBe(TimeOffRequestStatus.CONFIRMED);
      expect(result.hcmReferenceId).toBe('HCM-REF-123');
      expect(balanceService.confirmDeduction).toHaveBeenCalled();
    });

    it('should set status to HCM_REJECTED on HCM rejection', async () => {
      const request = { ...mockRequest, status: TimeOffRequestStatus.APPROVED };
      hcmService.submitDeduction.mockResolvedValue({
        success: false,
        error: 'Insufficient balance',
      });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);
      balanceService.removePendingDeduction.mockResolvedValue(mockBalance as any);

      const result = await service.submitToHcm(request);
      expect(result.status).toBe(TimeOffRequestStatus.HCM_REJECTED);
      expect(balanceService.removePendingDeduction).toHaveBeenCalled();
    });

    it('should keep SUBMITTED_TO_HCM status on network error', async () => {
      const request = { ...mockRequest, status: TimeOffRequestStatus.APPROVED };
      hcmService.submitDeduction.mockRejectedValue(new Error('Network error'));
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);

      const result = await service.submitToHcm(request);
      expect(result.status).toBe(TimeOffRequestStatus.SUBMITTED_TO_HCM);
    });
  });

  describe('reject', () => {
    it('should reject a pending request with reason', async () => {
      repo.findOne.mockResolvedValue({ ...mockRequest, status: TimeOffRequestStatus.PENDING });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);

      const result = await service.reject(1, 'Team at capacity');
      expect(result.status).toBe(TimeOffRequestStatus.REJECTED);
      expect(result.rejectionReason).toBe('Team at capacity');
    });

    it('should throw ConflictException for non-pending request', async () => {
      repo.findOne.mockResolvedValue({
        ...mockRequest,
        status: TimeOffRequestStatus.APPROVED,
      });

      await expect(service.reject(1, 'reason')).rejects.toThrow(ConflictException);
    });
  });

  describe('cancel', () => {
    it('should cancel a pending request', async () => {
      repo.findOne.mockResolvedValue({ ...mockRequest, status: TimeOffRequestStatus.PENDING });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);

      const result = await service.cancel(1);
      expect(result.status).toBe(TimeOffRequestStatus.CANCELLED);
      expect(balanceService.removePendingDeduction).not.toHaveBeenCalled();
    });

    it('should cancel an approved request and reverse pending deduction', async () => {
      repo.findOne.mockResolvedValue({ ...mockRequest, status: TimeOffRequestStatus.APPROVED });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);
      balanceService.removePendingDeduction.mockResolvedValue(mockBalance as any);

      const result = await service.cancel(1);
      expect(result.status).toBe(TimeOffRequestStatus.CANCELLED);
      expect(balanceService.removePendingDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'vacation',
        2,
      );
    });

    it('should cancel a SUBMITTED_TO_HCM request and reverse pending deduction', async () => {
      repo.findOne.mockResolvedValue({ ...mockRequest, status: TimeOffRequestStatus.SUBMITTED_TO_HCM });
      repo.save.mockImplementation(async (entity) => entity as TimeOffRequest);
      balanceService.removePendingDeduction.mockResolvedValue(mockBalance as any);

      const result = await service.cancel(1);
      expect(result.status).toBe(TimeOffRequestStatus.CANCELLED);
      expect(balanceService.removePendingDeduction).toHaveBeenCalled();
    });

    it('should throw ConflictException for confirmed request', async () => {
      repo.findOne.mockResolvedValue({
        ...mockRequest,
        status: TimeOffRequestStatus.CONFIRMED,
      });

      await expect(service.cancel(1)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException for already cancelled request', async () => {
      repo.findOne.mockResolvedValue({
        ...mockRequest,
        status: TimeOffRequestStatus.CANCELLED,
      });

      await expect(service.cancel(1)).rejects.toThrow(ConflictException);
    });
  });
});
