import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  HcmBalanceResponse,
  HcmDeductionRequest,
  HcmDeductionResponse,
} from './dto/hcm-response.dto.js';

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);
  private readonly baseUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.baseUrl = process.env['HCM_BASE_URL'] || 'http://localhost:4000';
  }

  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType?: string,
  ): Promise<HcmBalanceResponse[]> {
    try {
      const params: Record<string, string> = { employeeId, locationId };
      if (leaveType) {
        params['leaveType'] = leaveType;
      }

      const response = await firstValueFrom(
        this.httpService.get<HcmBalanceResponse[]>(
          `${this.baseUrl}/api/balances`,
          { params },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to fetch balance from HCM for employee=${employeeId}, location=${locationId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async submitDeduction(
    request: HcmDeductionRequest,
  ): Promise<HcmDeductionResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<HcmDeductionResponse>(
          `${this.baseUrl}/api/deductions`,
          request,
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to submit deduction to HCM for employee=${request.employeeId}, key=${request.idempotencyKey}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async cancelDeduction(referenceId: string): Promise<{ success: boolean }> {
    try {
      const response = await firstValueFrom(
        this.httpService.delete<{ success: boolean }>(
          `${this.baseUrl}/api/deductions/${referenceId}`,
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to cancel deduction on HCM, ref=${referenceId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
