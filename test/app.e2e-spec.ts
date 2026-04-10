import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MockHcmServer } from './mock-hcm/mock-hcm-server.js';
import { BalanceModule } from '../src/balance/balance.module.js';
import { RequestModule } from '../src/request/request.module.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { HcmModule } from '../src/hcm/hcm.module.js';
import { TimeOffBalance } from '../src/balance/entities/balance.entity.js';
import { TimeOffRequest } from '../src/request/entities/time-off-request.entity.js';
import { SyncLog } from '../src/sync/entities/sync-log.entity.js';
import type { Server } from 'http';

describe('Time-Off Microservice (e2e)', () => {
  let app: INestApplication;
  let mockHcm: MockHcmServer;
  let httpServer: Server;

  const futureDate = (daysAhead: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString().split('T')[0]!;
  };

  beforeAll(async () => {
    // Start mock HCM server
    mockHcm = new MockHcmServer();
    const port = await mockHcm.start();

    // Set the HCM base URL to our mock server
    process.env['HCM_BASE_URL'] = `http://localhost:${port}`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [TimeOffBalance, TimeOffRequest, SyncLog],
          synchronize: true,
        }),
        BalanceModule,
        RequestModule,
        SyncModule,
        HcmModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    httpServer = app.getHttpServer() as Server;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (mockHcm) await mockHcm.stop();
  });

  beforeEach(() => {
    mockHcm.resetState();
  });

  // ─── BALANCE ENDPOINTS ───────────────────────────────────────────

  describe('Balance Endpoints', () => {
    describe('GET /api/v1/balances/:employeeId', () => {
      it('should return empty balances for unknown employee', async () => {
        const res = await request(httpServer)
          .get('/api/v1/balances/emp-unknown')
          .expect(200);

        expect(res.body.employeeId).toBe('emp-unknown');
        expect(res.body.balances).toEqual([]);
      });

      it('should return balances after batch sync', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              {
                employeeId: 'emp-100',
                locationId: 'loc-us',
                leaveType: 'vacation',
                balance: 15,
              },
            ],
            timestamp: new Date().toISOString(),
          })
          .expect(201);

        const res = await request(httpServer)
          .get('/api/v1/balances/emp-100')
          .expect(200);

        expect(res.body.balances).toHaveLength(1);
        expect(res.body.balances[0].totalBalance).toBe(15);
        expect(res.body.balances[0].availableBalance).toBe(15);
        expect(res.body.balances[0].pendingDeductions).toBe(0);
      });

      it('should filter by locationId', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-101', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
              { employeeId: 'emp-101', locationId: 'loc-eu', leaveType: 'vacation', balance: 5 },
            ],
            timestamp: new Date().toISOString(),
          })
          .expect(201);

        const res = await request(httpServer)
          .get('/api/v1/balances/emp-101?locationId=loc-us')
          .expect(200);

        expect(res.body.balances).toHaveLength(1);
        expect(res.body.balances[0].locationId).toBe('loc-us');
      });

      it('should refresh from HCM when refresh=true', async () => {
        mockHcm.setBalance('emp-102', 'loc-us', 'vacation', 20);

        const res = await request(httpServer)
          .get('/api/v1/balances/emp-102?locationId=loc-us&refresh=true')
          .expect(200);

        expect(res.body.balances).toHaveLength(1);
        expect(res.body.balances[0].totalBalance).toBe(20);
      });
    });
  });

  // ─── TIME-OFF REQUEST LIFECYCLE ──────────────────────────────────

  describe('Time-Off Request Lifecycle', () => {
    beforeEach(async () => {
      await request(httpServer)
        .post('/api/v1/sync/batch')
        .send({
          balances: [
            {
              employeeId: 'emp-200',
              locationId: 'loc-us',
              leaveType: 'vacation',
              balance: 10,
            },
          ],
          timestamp: new Date().toISOString(),
        });

      mockHcm.setBalance('emp-200', 'loc-us', 'vacation', 10);
    });

    describe('POST /api/v1/time-off-requests', () => {
      it('should create a pending time-off request', async () => {
        const res = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 2,
            idempotencyKey: 'idem-001',
          })
          .expect(201);

        expect(res.body.status).toBe('PENDING');
        expect(res.body.employeeId).toBe('emp-200');
        expect(res.body.daysRequested).toBe(2);
      });

      it('should return existing request for duplicate idempotency key', async () => {
        const dto = {
          employeeId: 'emp-200',
          locationId: 'loc-us',
          leaveType: 'vacation',
          startDate: futureDate(10),
          endDate: futureDate(11),
          daysRequested: 2,
          idempotencyKey: 'idem-002',
        };

        const first = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send(dto)
          .expect(201);

        const second = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send(dto)
          .expect(201);

        expect(first.body.id).toBe(second.body.id);
      });

      it('should reject request with start date in the past', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: '2020-01-01',
            endDate: '2020-01-02',
            daysRequested: 2,
            idempotencyKey: 'idem-past',
          })
          .expect(400);
      });

      it('should reject request with end date before start date', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(15),
            endDate: futureDate(10),
            daysRequested: 2,
            idempotencyKey: 'idem-baddate',
          })
          .expect(400);
      });

      it('should reject request when balance is insufficient', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(25),
            daysRequested: 999,
            idempotencyKey: 'idem-toomuch',
          })
          .expect(400);
      });

      it('should reject request for unknown employee/location combination', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-unknown',
            locationId: 'loc-unknown',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-unknown',
          })
          .expect(404);
      });

      it('should reject request with missing required fields', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
          })
          .expect(400);
      });

      it('should reject request with negative daysRequested', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: -1,
            idempotencyKey: 'idem-neg',
          })
          .expect(400);
      });
    });

    describe('GET /api/v1/time-off-requests', () => {
      it('should list requests filtered by employee', async () => {
        await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-list-1',
          });

        const res = await request(httpServer)
          .get('/api/v1/time-off-requests?employeeId=emp-200')
          .expect(200);

        expect(res.body.length).toBeGreaterThanOrEqual(1);
        expect(res.body.every((r: any) => r.employeeId === 'emp-200')).toBe(true);
      });
    });

    describe('GET /api/v1/time-off-requests/:id', () => {
      it('should return a single request', async () => {
        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-get-1',
          });

        const res = await request(httpServer)
          .get(`/api/v1/time-off-requests/${created.body.id}`)
          .expect(200);

        expect(res.body.id).toBe(created.body.id);
      });

      it('should return 404 for non-existent request', async () => {
        await request(httpServer)
          .get('/api/v1/time-off-requests/99999')
          .expect(404);
      });
    });

    describe('PATCH /api/v1/time-off-requests/:id/approve', () => {
      it('should approve a pending request and submit to HCM', async () => {
        mockHcm.config.rejectInsufficientBalance = true;

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 2,
            idempotencyKey: 'idem-approve-1',
          });

        const res = await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        expect(res.body.status).toBe('APPROVED');

        // Wait for async HCM submission
        await new Promise((r) => setTimeout(r, 500));

        const updated = await request(httpServer)
          .get(`/api/v1/time-off-requests/${created.body.id}`)
          .expect(200);

        expect(updated.body.status).toBe('CONFIRMED');
        expect(updated.body.hcmReferenceId).toBeTruthy();

        // Verify balance was deducted
        const balanceRes = await request(httpServer)
          .get('/api/v1/balances/emp-200?locationId=loc-us')
          .expect(200);

        const vacBal = balanceRes.body.balances.find(
          (b: any) => b.leaveType === 'vacation',
        );
        expect(vacBal.totalBalance).toBe(8); // 10 - 2
        expect(vacBal.pendingDeductions).toBe(0);
      });

      it('should set HCM_REJECTED when HCM rejects the deduction', async () => {
        mockHcm.config.failDeductions = true;
        mockHcm.config.deductionErrorMessage = 'Policy violation';

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(20),
            endDate: futureDate(21),
            daysRequested: 1,
            idempotencyKey: 'idem-hcm-reject',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        await new Promise((r) => setTimeout(r, 500));

        const updated = await request(httpServer)
          .get(`/api/v1/time-off-requests/${created.body.id}`)
          .expect(200);

        expect(updated.body.status).toBe('HCM_REJECTED');
        expect(updated.body.rejectionReason).toBe('Policy violation');
      });

      it('should reject approving an already approved request', async () => {
        mockHcm.config.deductionDelayMs = 5000;

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(30),
            endDate: futureDate(30),
            daysRequested: 1,
            idempotencyKey: 'idem-double-approve',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(409);
      });
    });

    describe('PATCH /api/v1/time-off-requests/:id/reject', () => {
      it('should reject a pending request', async () => {
        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-reject-1',
          });

        const res = await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/reject`)
          .send({ reason: 'Team at full capacity' })
          .expect(200);

        expect(res.body.status).toBe('REJECTED');
        expect(res.body.rejectionReason).toBe('Team at full capacity');
      });

      it('should require a rejection reason', async () => {
        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-reject-noreason',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/reject`)
          .send({})
          .expect(400);
      });
    });

    describe('PATCH /api/v1/time-off-requests/:id/cancel', () => {
      it('should cancel a pending request', async () => {
        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-200',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-cancel-1',
          });

        const res = await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/cancel`)
          .expect(200);

        expect(res.body.status).toBe('CANCELLED');
      });

      it('should cancel an approved request and reverse pending deduction', async () => {
        // Use a fresh employee to avoid cross-test contamination
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-210', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
            ],
            timestamp: new Date().toISOString(),
          });
        mockHcm.setBalance('emp-210', 'loc-us', 'vacation', 10);
        mockHcm.config.deductionDelayMs = 10000; // Very slow HCM

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-210',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 2,
            idempotencyKey: 'idem-cancel-approved',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        // Verify pending deductions were added
        let balRes = await request(httpServer)
          .get('/api/v1/balances/emp-210?locationId=loc-us')
          .expect(200);
        const balBefore = balRes.body.balances.find(
          (b: any) => b.leaveType === 'vacation',
        );
        expect(balBefore.pendingDeductions).toBe(2);

        // Cancel immediately
        const res = await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/cancel`)
          .expect(200);

        expect(res.body.status).toBe('CANCELLED');

        // Verify pending deductions were reversed
        balRes = await request(httpServer)
          .get('/api/v1/balances/emp-210?locationId=loc-us')
          .expect(200);
        const balAfter = balRes.body.balances.find(
          (b: any) => b.leaveType === 'vacation',
        );
        expect(balAfter.pendingDeductions).toBe(0);
      });

      it('should not allow cancelling a confirmed request', async () => {
        // Use a fresh employee
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-211', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
            ],
            timestamp: new Date().toISOString(),
          });
        mockHcm.setBalance('emp-211', 'loc-us', 'vacation', 10);
        mockHcm.config.rejectInsufficientBalance = true;

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-211',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 1,
            idempotencyKey: 'idem-cancel-confirmed',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        // Wait for HCM confirmation
        await new Promise((r) => setTimeout(r, 500));

        const check = await request(httpServer)
          .get(`/api/v1/time-off-requests/${created.body.id}`)
          .expect(200);
        expect(check.body.status).toBe('CONFIRMED');

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/cancel`)
          .expect(409);
      });
    });
  });

  // ─── SYNC ENDPOINTS ──────────────────────────────────────────────

  describe('Sync Endpoints', () => {
    describe('POST /api/v1/sync/batch', () => {
      it('should process batch sync and create balance records', async () => {
        const res = await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-300', locationId: 'loc-us', leaveType: 'vacation', balance: 20 },
              { employeeId: 'emp-300', locationId: 'loc-us', leaveType: 'sick', balance: 10 },
              { employeeId: 'emp-301', locationId: 'loc-eu', leaveType: 'vacation', balance: 25 },
            ],
            timestamp: new Date().toISOString(),
          })
          .expect(201);

        expect(res.body.recordsProcessed).toBe(3);
        expect(res.body.recordsFailed).toBe(0);
        expect(res.body.status).toBe('SUCCESS');
      });

      it('should update existing balances while preserving pending deductions', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-302', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
            ],
            timestamp: new Date().toISOString(),
          });

        mockHcm.setBalance('emp-302', 'loc-us', 'vacation', 10);

        const req = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-302',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 3,
            idempotencyKey: 'idem-batch-pending',
          });

        mockHcm.config.deductionDelayMs = 10000;
        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${req.body.id}/approve`)
          .expect(200);

        // Batch sync with different balance
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-302', locationId: 'loc-us', leaveType: 'vacation', balance: 15 },
            ],
            timestamp: new Date().toISOString(),
          });

        const balRes = await request(httpServer)
          .get('/api/v1/balances/emp-302?locationId=loc-us')
          .expect(200);

        const vacBal = balRes.body.balances.find(
          (b: any) => b.leaveType === 'vacation',
        );
        expect(vacBal.totalBalance).toBe(15);
        expect(vacBal.pendingDeductions).toBe(3);
        expect(vacBal.availableBalance).toBe(12);
      });

      it('should validate batch sync request body', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({ invalid: true })
          .expect(400);
      });
    });

    describe('POST /api/v1/sync/trigger', () => {
      it('should trigger real-time sync from HCM', async () => {
        mockHcm.setBalance('emp-303', 'loc-us', 'vacation', 18);

        const res = await request(httpServer)
          .post('/api/v1/sync/trigger')
          .send({ employeeId: 'emp-303', locationId: 'loc-us' })
          .expect(201);

        expect(res.body.syncType).toBe('REALTIME');
        expect(res.body.status).toBe('SUCCESS');
      });

      it('should handle HCM failure gracefully', async () => {
        mockHcm.config.failBalances = true;

        const res = await request(httpServer)
          .post('/api/v1/sync/trigger')
          .send({ employeeId: 'emp-304', locationId: 'loc-us' })
          .expect(201);

        expect(res.body.status).toBe('FAILED');
      });
    });

    describe('GET /api/v1/sync/logs', () => {
      it('should return sync logs', async () => {
        mockHcm.setBalance('emp-305', 'loc-us', 'vacation', 5);
        await request(httpServer)
          .post('/api/v1/sync/trigger')
          .send({ employeeId: 'emp-305', locationId: 'loc-us' });

        const res = await request(httpServer)
          .get('/api/v1/sync/logs')
          .expect(200);

        expect(res.body.length).toBeGreaterThanOrEqual(1);
        expect(res.body[0]).toHaveProperty('syncType');
        expect(res.body[0]).toHaveProperty('status');
      });
    });
  });

  // ─── ADVANCED SCENARIOS ──────────────────────────────────────────

  describe('Advanced Scenarios', () => {
    describe('External balance changes (anniversary bonus)', () => {
      it('should reflect HCM balance increase after sync', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-400', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
            ],
            timestamp: new Date().toISOString(),
          });

        // Simulate anniversary bonus on HCM side
        mockHcm.setBalance('emp-400', 'loc-us', 'vacation', 15);

        await request(httpServer)
          .post('/api/v1/sync/trigger')
          .send({ employeeId: 'emp-400', locationId: 'loc-us' });

        const res = await request(httpServer)
          .get('/api/v1/balances/emp-400?locationId=loc-us')
          .expect(200);

        expect(res.body.balances[0].totalBalance).toBe(15);
      });
    });

    describe('HCM idempotency', () => {
      it('should not double-deduct on retry (HCM respects idempotency key)', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-401', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
            ],
            timestamp: new Date().toISOString(),
          });

        mockHcm.setBalance('emp-401', 'loc-us', 'vacation', 10);
        mockHcm.config.rejectInsufficientBalance = true;

        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-401',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(11),
            daysRequested: 3,
            idempotencyKey: 'idem-idempotent-1',
          });

        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        await new Promise((r) => setTimeout(r, 500));

        // Verify HCM only processed one deduction
        const deductions = mockHcm.getDeductions();
        const matching = deductions.filter(
          (d) => d.idempotencyKey === 'idem-idempotent-1',
        );
        expect(matching).toHaveLength(1);

        const hcmBalance = mockHcm.getStoredBalance('emp-401', 'loc-us', 'vacation');
        expect(hcmBalance).toBe(7);
      });
    });

    describe('Multiple leave types per employee', () => {
      it('should track balances independently per leave type', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-402', locationId: 'loc-us', leaveType: 'vacation', balance: 10 },
              { employeeId: 'emp-402', locationId: 'loc-us', leaveType: 'sick', balance: 5 },
              { employeeId: 'emp-402', locationId: 'loc-us', leaveType: 'personal', balance: 3 },
            ],
            timestamp: new Date().toISOString(),
          });

        const res = await request(httpServer)
          .get('/api/v1/balances/emp-402')
          .expect(200);

        expect(res.body.balances).toHaveLength(3);
      });
    });

    describe('Multiple locations per employee', () => {
      it('should track balances independently per location', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-403', locationId: 'loc-us', leaveType: 'vacation', balance: 15 },
              { employeeId: 'emp-403', locationId: 'loc-eu', leaveType: 'vacation', balance: 25 },
            ],
            timestamp: new Date().toISOString(),
          });

        const usRes = await request(httpServer)
          .get('/api/v1/balances/emp-403?locationId=loc-us')
          .expect(200);
        expect(usRes.body.balances[0].totalBalance).toBe(15);

        const euRes = await request(httpServer)
          .get('/api/v1/balances/emp-403?locationId=loc-eu')
          .expect(200);
        expect(euRes.body.balances[0].totalBalance).toBe(25);
      });
    });

    describe('Concurrent request protection', () => {
      it('should prevent spending more than available balance across multiple requests', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-404', locationId: 'loc-us', leaveType: 'vacation', balance: 5 },
            ],
            timestamp: new Date().toISOString(),
          });

        mockHcm.setBalance('emp-404', 'loc-us', 'vacation', 5);
        mockHcm.config.deductionDelayMs = 5000;

        const req1 = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-404',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(12),
            daysRequested: 3,
            idempotencyKey: 'idem-concurrent-1',
          });

        const req2 = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-404',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(20),
            endDate: futureDate(22),
            daysRequested: 3,
            idempotencyKey: 'idem-concurrent-2',
          });

        // Approve first
        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${req1.body.id}/approve`)
          .expect(200);

        // Second approval should fail — only 2 remaining
        await request(httpServer)
          .patch(`/api/v1/time-off-requests/${req2.body.id}/approve`)
          .expect(400);
      });
    });

    describe('Full happy path lifecycle', () => {
      it('should handle complete request lifecycle: create -> approve -> HCM confirm', async () => {
        await request(httpServer)
          .post('/api/v1/sync/batch')
          .send({
            balances: [
              { employeeId: 'emp-500', locationId: 'loc-us', leaveType: 'vacation', balance: 20 },
            ],
            timestamp: new Date().toISOString(),
          });

        mockHcm.setBalance('emp-500', 'loc-us', 'vacation', 20);
        mockHcm.config.rejectInsufficientBalance = true;

        // Step 1: Employee creates request
        const created = await request(httpServer)
          .post('/api/v1/time-off-requests')
          .send({
            employeeId: 'emp-500',
            locationId: 'loc-us',
            leaveType: 'vacation',
            startDate: futureDate(10),
            endDate: futureDate(14),
            daysRequested: 5,
            idempotencyKey: 'idem-full-lifecycle',
          })
          .expect(201);

        expect(created.body.status).toBe('PENDING');

        // Step 2: Manager approves
        const approved = await request(httpServer)
          .patch(`/api/v1/time-off-requests/${created.body.id}/approve`)
          .expect(200);

        expect(approved.body.status).toBe('APPROVED');

        // Step 3: Wait for HCM confirmation
        await new Promise((r) => setTimeout(r, 500));

        const confirmed = await request(httpServer)
          .get(`/api/v1/time-off-requests/${created.body.id}`)
          .expect(200);

        expect(confirmed.body.status).toBe('CONFIRMED');
        expect(confirmed.body.hcmReferenceId).toBeTruthy();

        // Step 4: Verify final balance
        const balRes = await request(httpServer)
          .get('/api/v1/balances/emp-500?locationId=loc-us')
          .expect(200);

        const vacBal = balRes.body.balances.find(
          (b: any) => b.leaveType === 'vacation',
        );
        expect(vacBal.totalBalance).toBe(15); // 20 - 5
        expect(vacBal.pendingDeductions).toBe(0);
        expect(vacBal.availableBalance).toBe(15);
      });
    });
  });
});
