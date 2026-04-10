export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  leaveType: string;
  balance: number;
}

export interface HcmDeductionResponse {
  success: boolean;
  referenceId?: string;
  error?: string;
  errorCode?: string;
}

export interface HcmDeductionRequest {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  idempotencyKey: string;
}
