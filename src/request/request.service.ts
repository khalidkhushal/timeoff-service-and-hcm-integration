import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from './entities/time-off-request.entity.js';
import { BalanceService } from '../balance/balance.service.js';
import { HcmService } from '../hcm/hcm.service.js';
import { CreateTimeOffRequestDto } from '../common/dto/create-time-off-request.dto.js';

@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
  ) {}

  async create(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    // Idempotency check
    const existing = await this.requestRepo.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      return existing;
    }

    // Validate dates
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (startDate < today) {
      throw new BadRequestException('Start date must be today or in the future');
    }
    if (endDate < startDate) {
      throw new BadRequestException('End date must be on or after start date');
    }

    // Defensive local balance check
    const balance = await this.balanceService.getBalance(
      dto.employeeId,
      dto.locationId,
      dto.leaveType,
    );

    if (!balance) {
      throw new NotFoundException(
        `No balance record found for employee=${dto.employeeId}, location=${dto.locationId}, type=${dto.leaveType}`,
      );
    }

    const available = Number(balance.balance) - Number(balance.pendingDeductions);
    if (available < dto.daysRequested) {
      throw new BadRequestException(
        `Insufficient balance: available=${available}, requested=${dto.daysRequested}`,
      );
    }

    const request = this.requestRepo.create({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      leaveType: dto.leaveType,
      startDate: dto.startDate,
      endDate: dto.endDate,
      daysRequested: dto.daysRequested,
      status: TimeOffRequestStatus.PENDING,
      idempotencyKey: dto.idempotencyKey,
    });

    return this.requestRepo.save(request);
  }

  async findOne(id: number): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Time-off request #${id} not found`);
    }
    return request;
  }

  async findAll(filters: {
    employeeId?: string;
    status?: TimeOffRequestStatus;
    locationId?: string;
  }): Promise<TimeOffRequest[]> {
    const where: Record<string, string | TimeOffRequestStatus> = {};
    if (filters.employeeId) where['employeeId'] = filters.employeeId;
    if (filters.status) where['status'] = filters.status;
    if (filters.locationId) where['locationId'] = filters.locationId;

    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async approve(id: number): Promise<TimeOffRequest> {
    const request = await this.findOne(id);

    if (request.status !== TimeOffRequestStatus.PENDING) {
      throw new ConflictException(
        `Request #${id} cannot be approved — current status is ${request.status}`,
      );
    }

    // Re-validate balance defensively before approval
    const balance = await this.balanceService.getBalance(
      request.employeeId,
      request.locationId,
      request.leaveType,
    );

    if (!balance) {
      throw new NotFoundException('Balance record not found');
    }

    const available = Number(balance.balance) - Number(balance.pendingDeductions);
    if (available < Number(request.daysRequested)) {
      throw new BadRequestException(
        `Insufficient balance at approval time: available=${available}, requested=${request.daysRequested}`,
      );
    }

    // Reserve the balance locally (optimistic lock on balance entity via version column)
    await this.balanceService.addPendingDeduction(
      request.employeeId,
      request.locationId,
      request.leaveType,
      Number(request.daysRequested),
    );

    request.status = TimeOffRequestStatus.APPROVED;
    const savedRequest = await this.requestRepo.save(request);

    // Return a snapshot of the approved state before async HCM submission mutates it
    const snapshot = { ...savedRequest };

    // Submit to HCM asynchronously (fire-and-forget)
    this.submitToHcm(savedRequest).catch((err) => {
      this.logger.error(
        `Async HCM submission failed for request #${id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    return snapshot;
  }

  async submitToHcm(request: TimeOffRequest): Promise<TimeOffRequest> {
    request.status = TimeOffRequestStatus.SUBMITTED_TO_HCM;
    await this.requestRepo.save(request);

    try {
      const hcmResponse = await this.hcmService.submitDeduction({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: Number(request.daysRequested),
        idempotencyKey: request.idempotencyKey,
      });

      if (hcmResponse.success) {
        request.status = TimeOffRequestStatus.CONFIRMED;
        request.hcmReferenceId = hcmResponse.referenceId || null;

        // Move from pending to actual deduction
        await this.balanceService.confirmDeduction(
          request.employeeId,
          request.locationId,
          request.leaveType,
          Number(request.daysRequested),
        );

        this.logger.log(
          `Request #${request.id} confirmed by HCM, ref=${hcmResponse.referenceId}`,
        );
      } else {
        request.status = TimeOffRequestStatus.HCM_REJECTED;
        request.rejectionReason = hcmResponse.error || 'Rejected by HCM';

        // Reverse the pending deduction
        await this.balanceService.removePendingDeduction(
          request.employeeId,
          request.locationId,
          request.leaveType,
          Number(request.daysRequested),
        );

        this.logger.warn(
          `Request #${request.id} rejected by HCM: ${hcmResponse.error}`,
        );
      }
    } catch (error) {
      // Network error — keep as SUBMITTED_TO_HCM for retry
      this.logger.error(
        `HCM submission error for request #${request.id} — will need retry`,
        error instanceof Error ? error.stack : String(error),
      );
      // Status stays SUBMITTED_TO_HCM — a retry mechanism would pick this up
    }

    return this.requestRepo.save(request);
  }

  async reject(id: number, reason: string): Promise<TimeOffRequest> {
    const request = await this.findOne(id);

    if (request.status !== TimeOffRequestStatus.PENDING) {
      throw new ConflictException(
        `Request #${id} cannot be rejected — current status is ${request.status}`,
      );
    }

    request.status = TimeOffRequestStatus.REJECTED;
    request.rejectionReason = reason;
    return this.requestRepo.save(request);
  }

  async cancel(id: number): Promise<TimeOffRequest> {
    const request = await this.findOne(id);

    if (
      request.status !== TimeOffRequestStatus.PENDING &&
      request.status !== TimeOffRequestStatus.APPROVED &&
      request.status !== TimeOffRequestStatus.SUBMITTED_TO_HCM
    ) {
      throw new ConflictException(
        `Request #${id} cannot be cancelled — current status is ${request.status}`,
      );
    }

    // If it was approved or submitted to HCM, reverse the pending deduction
    if (
      request.status === TimeOffRequestStatus.APPROVED ||
      request.status === TimeOffRequestStatus.SUBMITTED_TO_HCM
    ) {
      await this.balanceService.removePendingDeduction(
        request.employeeId,
        request.locationId,
        request.leaveType,
        Number(request.daysRequested),
      );
    }

    request.status = TimeOffRequestStatus.CANCELLED;
    return this.requestRepo.save(request);
  }
}
