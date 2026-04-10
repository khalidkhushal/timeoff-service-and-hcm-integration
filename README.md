# Time-Off Microservice

A NestJS-based backend microservice that manages employee time-off requests and maintains balance integrity with an external Human Capital Management (HCM) system.

## Architecture Overview

```
Employee/Manager UI  <-->  Time-Off Microservice  <-->  HCM (Source of Truth)
                                  |
                             SQLite (local cache)
```

**Key design decisions:**
- Balances are cached locally (per-employee, per-location, per-leave-type) for fast reads
- HCM is the source of truth — synced via real-time API, batch push, and scheduled hourly refresh
- Pending deductions track approved-but-unconfirmed requests to prevent double-spend
- Optimistic locking prevents race conditions on concurrent balance modifications
- Idempotency keys prevent duplicate HCM deductions on retries
- Defensive local validation before HCM submission (HCM validation is not guaranteed)

## Tech Stack

- **NestJS 11** — Node.js framework
- **TypeORM** — ORM with SQLite via better-sqlite3
- **@nestjs/schedule** — Cron-based scheduled jobs
- **class-validator** — DTO validation
- **Axios** — HTTP client for HCM integration
- **Jest + Supertest** — Testing

## Prerequisites

- **Node.js** >= 18 (tested with Node 22)
- **npm** >= 9
- No database installation required — SQLite is embedded and creates its file automatically

## Setup & Run

```bash
# 1. Navigate into the project directory
cd time-off-service

# 2. Install dependencies
npm install

# 3. Start the server (development mode with hot-reload)
npm run start:dev
```

The server starts on `http://localhost:3000`. You should see:

```
Time-Off Service running on port 3000
```

### Verify the Server is Running

```bash
# Seed a balance via batch sync
curl -X POST http://localhost:3000/api/v1/sync/batch \
  -H "Content-Type: application/json" \
  -d '{"balances":[{"employeeId":"emp-1","locationId":"loc-us","leaveType":"vacation","balance":10}],"timestamp":"2026-04-10T00:00:00Z"}'

# Check the balance
curl http://localhost:3000/api/v1/balances/emp-1
```

### Production Build

```bash
npm run build
npm run start:prod
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HCM_BASE_URL` | `http://localhost:4000` | Base URL of the HCM API |
| `DB_PATH` | `time-off.db` | SQLite database file path (auto-created) |

## Running Tests

```bash
# Unit tests (53 tests)
npm test

# E2E tests (35 tests — spins up a real mock HCM HTTP server)
npm run test:e2e -- --runInBand --forceExit

# All tests combined with coverage report (88 tests)
npm run test:all:cov
```

### Viewing the Coverage Report

After running `npm run test:all:cov`, coverage is generated in three formats:

| Format | Location | How to view |
|---|---|---|
| **HTML report** | `coverage/lcov-report/index.html` | Open in browser — interactive, per-file line highlighting |
| **Text summary** | `coverage-summary.txt` | `cat coverage-summary.txt` |
| **LCOV / Clover XML** | `coverage/lcov.info`, `coverage/clover.xml` | For CI tool integration |

### Test Coverage Summary (88 tests)

```
All files:       91.3% statements | 75.6% branches | 93.6% functions | 91.8% lines
Services:        97-100% coverage
Controllers:     100% coverage
DTOs:            100% coverage
```

### Mock HCM Server

The e2e tests use a **real HTTP server** (`test/mock-hcm/mock-hcm-server.ts`) that simulates the HCM system. It:
- Starts on a random port before tests and shuts down after
- Maintains in-memory balance state
- Processes deductions and respects idempotency keys
- Is configurable per test to simulate: failures, delays, insufficient balance rejections

No separate setup is required — the mock server is started automatically by the test suite.

### Key Test Scenarios Covered

1. Happy path: create -> approve -> HCM confirms -> balance deducted
2. Insufficient balance rejection (local defensive validation)
3. HCM rejection after local approval (status rollback + balance reversal)
4. Concurrent request protection (pending deductions prevent double-spend)
5. Batch sync preserving in-flight pending deductions
6. External balance changes (anniversary bonus reflected after sync)
7. HCM idempotency (no double-deduction on retry)
8. Request cancellation from all valid states (pending, approved, submitted-to-HCM)
9. Idempotent request creation (duplicate idempotency key returns existing)
10. Input validation (bad dates, negative days, missing fields, unknown combos)
11. Multiple leave types and locations per employee
12. HCM failure handling (timeouts, errors)
13. Sync audit logging
14. Scheduled batch refresh of stale balances
15. Scheduled cleanup of old sync logs

## API Endpoints

### Balances

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/balances/:employeeId` | Get balances (query: `locationId`, `leaveType`, `refresh`) |

### Time-Off Requests

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/time-off-requests` | Create a new request |
| `GET` | `/api/v1/time-off-requests` | List requests (query: `employeeId`, `status`, `locationId`) |
| `GET` | `/api/v1/time-off-requests/:id` | Get a single request |
| `PATCH` | `/api/v1/time-off-requests/:id/approve` | Approve a request |
| `PATCH` | `/api/v1/time-off-requests/:id/reject` | Reject a request (body: `{ reason }`) |
| `PATCH` | `/api/v1/time-off-requests/:id/cancel` | Cancel a request |

### Sync

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/sync/batch` | Receive batch balance sync from HCM |
| `POST` | `/api/v1/sync/trigger` | Trigger real-time sync for an employee/location |
| `GET` | `/api/v1/sync/logs` | View sync audit logs |

## Request Lifecycle

```
PENDING --> APPROVED --> SUBMITTED_TO_HCM --> CONFIRMED
                                          --> HCM_REJECTED
        --> REJECTED (by manager)
        --> CANCELLED (by employee, from PENDING / APPROVED / SUBMITTED_TO_HCM)
```

## Scheduled Jobs

| Schedule | Job | Purpose |
|---|---|---|
| Every hour | `scheduledBatchRefresh` | Syncs stale balances (not refreshed in >1 hour) from HCM |
| Every midnight | `cleanupOldSyncLogs` | Deletes sync log entries older than 90 days |

## Project Structure

```
src/
  app.module.ts                        Root module (TypeORM + ScheduleModule)
  main.ts                              Bootstrap with validation pipe
  common/
    dto/                               Shared request DTOs with validation
    filters/                           Global exception filter
  balance/
    balance.module.ts
    balance.controller.ts              Balance query endpoints
    balance.service.ts                 Balance CRUD, sync, pending deduction mgmt
    balance.service.spec.ts            Unit tests (18)
    entities/balance.entity.ts         TimeOffBalance entity with optimistic lock
  request/
    request.module.ts
    request.controller.ts              Request lifecycle endpoints
    request.service.ts                 Full lifecycle with async HCM submission
    request.service.spec.ts            Unit tests (23)
    entities/time-off-request.entity.ts
  hcm/
    hcm.module.ts
    hcm.service.ts                     HCM API client (balance fetch, deduction)
    dto/hcm-response.dto.ts            HCM response interfaces
  sync/
    sync.module.ts
    sync.controller.ts                 Batch sync webhook + trigger endpoint
    sync.service.ts                    Batch/real-time sync + scheduled cron jobs
    sync.service.spec.ts               Unit tests (12)
    entities/sync-log.entity.ts        Sync audit trail

test/
  app.e2e-spec.ts                      E2E tests (35)
  mock-hcm/
    mock-hcm-server.ts                 Real HTTP mock HCM server
  jest-e2e.json                        E2E Jest config
  jest-all.json                        Combined (unit + e2e) Jest config

docs/
  TRD.md                               Technical Requirement Document
```

## Documentation

See [docs/TRD.md](docs/TRD.md) for the full Technical Requirement Document covering:
- Problem statement and user personas
- Technical challenges (eventual consistency, race conditions, unreliable HCM)
- Proposed architecture and data model
- API design with request/response examples
- HCM sync strategy (batch + real-time + scheduled refresh)
- Scheduled jobs (hourly balance refresh, nightly log cleanup)
- Defensive programming approach
- Security considerations
- Alternatives considered (event-driven, CQRS, pessimistic locking, GraphQL)
- Test strategy
