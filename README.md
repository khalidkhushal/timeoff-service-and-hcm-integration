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
- HCM is the source of truth — balances are synced via real-time and batch APIs
- Pending deductions track approved-but-unconfirmed requests to prevent double-spend
- Optimistic locking prevents race conditions on concurrent balance modifications
- Idempotency keys prevent duplicate HCM deductions on retries
- Defensive local validation before HCM submission (HCM validation is not guaranteed)

## Tech Stack

- **NestJS 11** — Node.js framework
- **TypeORM** — ORM with SQLite via better-sqlite3
- **class-validator** — DTO validation
- **Axios** — HTTP client for HCM integration
- **Jest + Supertest** — Testing

## Prerequisites

- Node.js >= 18
- npm >= 9

## Setup & Run

```bash
# Install dependencies
npm install

# Start in development mode
npm run start:dev

# Start in production mode
npm run build
npm run start:prod
```

The service runs on port 3000 by default. Configure via `PORT` environment variable.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HCM_BASE_URL` | `http://localhost:4000` | Base URL of the HCM API |
| `DB_PATH` | `time-off.db` | SQLite database file path |

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

## Running Tests

```bash
# Unit tests only (48 tests)
npm test

# E2E tests only (35 tests, uses a real mock HCM HTTP server)
npm run test:e2e -- --runInBand --forceExit

# All tests combined with coverage report (83 tests)
npm run test:all:cov
```

### Test Architecture

- **48 unit tests** — test business logic in services with mocked dependencies
- **35 e2e tests** — full HTTP lifecycle tests against a real NestJS app with in-memory SQLite and a **real mock HCM HTTP server**

The mock HCM server (`test/mock-hcm/mock-hcm-server.ts`) is a real Node.js HTTP server that:
- Maintains in-memory balance state
- Processes deductions with configurable behaviors
- Respects idempotency keys
- Can simulate failures, delays, and balance rejections

### Test Coverage Summary

```
All files:       91% statements | 75% branches | 93% functions | 91% lines
Services:        97-100% coverage
Controllers:     100% coverage
DTOs:            100% coverage
```

### Key Test Scenarios Covered

1. Happy path: create -> approve -> HCM confirms -> balance deducted
2. Insufficient balance rejection (local defensive validation)
3. HCM rejection after local approval (status rollback + balance reversal)
4. Concurrent request protection (pending deductions prevent double-spend)
5. Batch sync preserving in-flight pending deductions
6. External balance changes (anniversary bonus reflected after sync)
7. HCM idempotency (no double-deduction on retry)
8. Request cancellation from all valid states (pending, approved, submitted)
9. Idempotent request creation (duplicate idempotency key returns existing)
10. Input validation (bad dates, negative days, missing fields, unknown combos)
11. Multiple leave types and locations per employee
12. HCM failure handling (timeouts, errors)
13. Sync audit logging

## Project Structure

```
src/
  app.module.ts                        Root module with TypeORM config
  main.ts                              Bootstrap with validation pipe
  common/
    dto/                               Shared request DTOs with validation
    filters/                           Global exception filter
  balance/
    balance.module.ts
    balance.controller.ts              Balance query endpoints
    balance.service.ts                 Balance CRUD, sync, pending deduction mgmt
    balance.service.spec.ts            17 unit tests
    entities/balance.entity.ts         TimeOffBalance entity with optimistic lock
  request/
    request.module.ts
    request.controller.ts              Request lifecycle endpoints
    request.service.ts                 Full lifecycle with async HCM submission
    request.service.spec.ts            18 unit tests
    entities/time-off-request.entity.ts
  hcm/
    hcm.module.ts
    hcm.service.ts                     HCM API client (balance fetch, deduction)
    dto/hcm-response.dto.ts            HCM response interfaces
  sync/
    sync.module.ts
    sync.controller.ts                 Batch sync webhook + trigger endpoint
    sync.service.ts                    Batch and real-time sync processing
    sync.service.spec.ts               7 unit tests
    entities/sync-log.entity.ts        Sync audit trail

test/
  app.e2e-spec.ts                      35 e2e tests
  mock-hcm/
    mock-hcm-server.ts                 Real HTTP mock HCM server
  jest-e2e.json                        E2E Jest config
  jest-all.json                        Combined Jest config

docs/
  TRD.md                               Technical Requirement Document
```

## Documentation

See [docs/TRD.md](docs/TRD.md) for the full Technical Requirement Document covering:
- Problem statement and user personas
- Technical challenges (eventual consistency, race conditions, unreliable HCM)
- Proposed architecture and data model
- API design with request/response examples
- HCM sync strategy (batch + real-time)
- Defensive programming approach
- Security considerations
- Alternatives considered (event-driven, CQRS, pessimistic locking, GraphQL)
- Test strategy
