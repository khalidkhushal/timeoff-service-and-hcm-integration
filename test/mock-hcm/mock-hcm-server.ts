import * as http from 'http';

export interface MockBalance {
  employeeId: string;
  locationId: string;
  leaveType: string;
  balance: number;
}

export interface MockDeduction {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  idempotencyKey: string;
  referenceId: string;
}

export interface MockHcmConfig {
  /** If true, deduction requests will fail */
  failDeductions?: boolean;
  /** Custom error message for failed deductions */
  deductionErrorMessage?: string;
  /** If true, balance requests will fail */
  failBalances?: boolean;
  /** Delay in ms before responding to deduction requests */
  deductionDelayMs?: number;
  /** If true, respond with HCM rejecting due to insufficient balance */
  rejectInsufficientBalance?: boolean;
}

/**
 * A real HTTP mock server that simulates an HCM system.
 * It maintains in-memory state for balances and processes deductions.
 */
export class MockHcmServer {
  private server: http.Server | null = null;
  private balances: Map<string, MockBalance> = new Map();
  private deductions: MockDeduction[] = [];
  private processedIdempotencyKeys: Map<string, string> = new Map();
  public config: MockHcmConfig = {};
  public port = 0;

  private balanceKey(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): string {
    return `${employeeId}:${locationId}:${leaveType}`;
  }

  setBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    balance: number,
  ): void {
    const key = this.balanceKey(employeeId, locationId, leaveType);
    this.balances.set(key, { employeeId, locationId, leaveType, balance });
  }

  getStoredBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): number | undefined {
    const key = this.balanceKey(employeeId, locationId, leaveType);
    return this.balances.get(key)?.balance;
  }

  getDeductions(): MockDeduction[] {
    return [...this.deductions];
  }

  resetState(): void {
    this.balances.clear();
    this.deductions = [];
    this.processedIdempotencyKeys.clear();
    this.config = {};
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address !== null) {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);

    if (req.method === 'GET' && url.pathname === '/api/balances') {
      this.handleGetBalances(url, res);
    } else if (req.method === 'POST' && url.pathname === '/api/deductions') {
      this.handlePostDeduction(req, res);
    } else if (
      req.method === 'DELETE' &&
      url.pathname.startsWith('/api/deductions/')
    ) {
      this.handleDeleteDeduction(url, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleGetBalances(url: URL, res: http.ServerResponse): void {
    if (this.config.failBalances) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'HCM internal error' }));
      return;
    }

    const employeeId = url.searchParams.get('employeeId');
    const locationId = url.searchParams.get('locationId');
    const leaveType = url.searchParams.get('leaveType');

    const results: MockBalance[] = [];
    for (const balance of this.balances.values()) {
      if (employeeId && balance.employeeId !== employeeId) continue;
      if (locationId && balance.locationId !== locationId) continue;
      if (leaveType && balance.leaveType !== leaveType) continue;
      results.push({ ...balance });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
  }

  private handlePostDeduction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const delayMs = this.config.deductionDelayMs || 0;

      const processDeduction = () => {
        try {
          const data = JSON.parse(body) as {
            employeeId: string;
            locationId: string;
            leaveType: string;
            days: number;
            idempotencyKey: string;
          };

          // Idempotency check
          const existingRef = this.processedIdempotencyKeys.get(
            data.idempotencyKey,
          );
          if (existingRef) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                referenceId: existingRef,
              }),
            );
            return;
          }

          if (this.config.failDeductions) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error:
                  this.config.deductionErrorMessage || 'HCM deduction failed',
                errorCode: 'HCM_ERROR',
              }),
            );
            return;
          }

          const key = this.balanceKey(
            data.employeeId,
            data.locationId,
            data.leaveType,
          );
          const balance = this.balances.get(key);

          if (!balance) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: 'Invalid dimension combination',
                errorCode: 'INVALID_DIMENSIONS',
              }),
            );
            return;
          }

          if (
            this.config.rejectInsufficientBalance &&
            balance.balance < data.days
          ) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: 'Insufficient balance',
                errorCode: 'INSUFFICIENT_BALANCE',
              }),
            );
            return;
          }

          // Process the deduction
          balance.balance -= data.days;
          const referenceId = `HCM-REF-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

          this.deductions.push({
            ...data,
            referenceId,
          });
          this.processedIdempotencyKeys.set(data.idempotencyKey, referenceId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              referenceId,
            }),
          );
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      };

      if (delayMs > 0) {
        setTimeout(processDeduction, delayMs);
      } else {
        processDeduction();
      }
    });
  }

  private handleDeleteDeduction(
    url: URL,
    res: http.ServerResponse,
  ): void {
    const referenceId = url.pathname.split('/').pop();
    const deductionIndex = this.deductions.findIndex(
      (d) => d.referenceId === referenceId,
    );

    if (deductionIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Deduction not found' }));
      return;
    }

    const deduction = this.deductions[deductionIndex]!;
    // Restore the balance
    const key = this.balanceKey(
      deduction.employeeId,
      deduction.locationId,
      deduction.leaveType,
    );
    const balance = this.balances.get(key);
    if (balance) {
      balance.balance += deduction.days;
    }

    this.deductions.splice(deductionIndex, 1);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }
}
