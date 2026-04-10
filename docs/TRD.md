# Technical Requirement Document: Time-Off Microservice

**Author:** Khalid Khushal  
**Date:** 2026-04-10  
**Status:** Final  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [User Personas & Requirements](#3-user-personas--requirements)
4. [Technical Challenges](#4-technical-challenges)
5. [Proposed Solution](#5-proposed-solution)
6. [Data Model](#6-data-model)
7. [API Design](#7-api-design)
8. [HCM Integration & Sync Strategy](#8-hcm-integration--sync-strategy)
9. [Defensive Programming & Error Handling](#9-defensive-programming--error-handling)
10. [Security Considerations](#10-security-considerations)
11. [Alternatives Considered](#11-alternatives-considered)
12. [Test Strategy](#12-test-strategy)
13. [Non-Functional Requirements](#13-non-functional-requirements)
14. [Future Considerations](#14-future-considerations)

---

## 1. Executive Summary

This document describes the technical design for the **Time-Off Microservice** — a NestJS-based backend system that manages employee time-off requests and maintains balance integrity between ExampleHR and an external Human Capital Management (HCM) system.

The core challenge is **dual-system consistency**: the HCM is the source of truth for balances, but ExampleHR must provide fast, accurate feedback to employees and managers while handling cases where the HCM changes balances independently (anniversary bonuses, annual resets) and where the HCM may not always reliably validate requests.

---

## 2. Problem Statement

ExampleHR provides a user-friendly interface for time-off requests, but the HCM (e.g., Workday, SAP) is the authoritative source of employment and balance data. This creates a **distributed state** problem:

- An employee with 10 days of leave requests 2 days on ExampleHR. We must ensure the HCM agrees the balance exists.
- The HCM may independently update balances (work anniversary bonuses, annual resets) without notifying ExampleHR synchronously.
- The HCM *usually* rejects invalid requests (insufficient balance, invalid dimensions) but **this is not guaranteed** — we must be defensive.
- Multiple systems may interact with the HCM concurrently, making our local balance a potentially stale cache.

**Goal:** Build a microservice that provides responsive time-off management while maintaining balance integrity with the HCM, handling sync failures gracefully, and protecting against data inconsistencies.

---

## 3. User Personas & Requirements

### 3.1 The Employee
| Requirement | Priority |
|---|---|
| View accurate, up-to-date time-off balance | P0 |
| Submit time-off requests with instant feedback | P0 |
| See request status (pending, approved, rejected, cancelled) | P0 |
| Cancel a pending request | P1 |

### 3.2 The Manager
| Requirement | Priority |
|---|---|
| View pending requests for their reports | P0 |
| Approve or reject requests with confidence that data is valid | P0 |
| See current balance for the employee being approved | P0 |

### 3.3 System (Internal)
| Requirement | Priority |
|---|---|
| Sync balances from HCM in real-time and batch modes | P0 |
| Submit approved requests to HCM and handle all response scenarios | P0 |
| Maintain an audit log of sync operations | P1 |
| Defensive local validation before HCM submission | P0 |
| Scheduled hourly refresh of stale balances from HCM | P1 |
| Automated cleanup of sync logs older than 90 days | P2 |

---

## 4. Technical Challenges

### Challenge 1: Eventual Consistency Between Systems
The HCM is the source of truth, but we maintain a local cache of balances for responsiveness. Balances can change externally at any time (anniversary bonuses, manual HR adjustments, other integrated systems). Our local state is always potentially stale.

### Challenge 2: Unreliable HCM Validation
The HCM is expected to reject requests against insufficient balances or invalid dimension combinations, **but this is not guaranteed**. We cannot blindly trust the HCM to be our only validation layer.

### Challenge 3: Race Conditions on Concurrent Requests
Two time-off requests from the same employee (or processed simultaneously) could each pass local validation independently but together exceed the available balance. Classic double-spend problem.

### Challenge 4: Batch vs. Real-Time Sync Conflicts
Batch syncs provide a full snapshot of balances but may arrive while real-time operations are in flight. A batch sync that overwrites a balance mid-request could corrupt the state.

### Challenge 5: Request Lifecycle Spanning Two Systems
A time-off request goes through local states (pending → approved → submitted-to-HCM → confirmed/failed). Failures at the HCM submission stage must be handled gracefully — the request was already approved by the manager.

### Challenge 6: Idempotency of External Operations
Network failures during HCM submission may leave us uncertain about whether the deduction was applied. Re-submitting without idempotency could double-deduct.

---

## 5. Proposed Solution

### 5.1 Architecture Overview

```
┌─────────────┐     REST API      ┌──────────────────────┐     HTTP     ┌─────────┐
│  Employee /  │ ◄──────────────► │  Time-Off            │ ◄──────────► │   HCM   │
│  Manager UI  │                  │  Microservice        │              │ (Source  │
└─────────────┘                   │                      │              │ of Truth)│
                                  │  ┌────────────────┐  │              └─────────┘
                                  │  │ Balance Module │  │                    │
                                  │  ├────────────────┤  │                    │
                                  │  │ Request Module │  │   Batch Sync       │
                                  │  ├────────────────┤  │ ◄─────────────────┘
                                  │  │ HCM Client     │  │
                                  │  ├────────────────┤  │
                                  │  │ SQLite DB      │  │
                                  │  └────────────────┘  │
                                  └──────────────────────┘
```

### 5.2 Tech Stack
- **Runtime:** Node.js with NestJS framework
- **Database:** SQLite via TypeORM
- **HTTP Client:** Axios (via NestJS HttpModule)
- **Scheduling:** @nestjs/schedule (cron-based jobs)
- **Testing:** Jest with Supertest for e2e, built-in NestJS testing utilities
- **Validation:** class-validator + class-transformer

### 5.3 Module Structure
```
src/
├── app.module.ts
├── main.ts
├── common/
│   ├── dto/                    # Shared DTOs
│   ├── filters/                # Exception filters
│   └── guards/                 # Auth guards (placeholder)
├── balance/
│   ├── balance.module.ts
│   ├── balance.controller.ts
│   ├── balance.service.ts
│   └── entities/
│       └── balance.entity.ts
├── request/
│   ├── request.module.ts
│   ├── request.controller.ts
│   ├── request.service.ts
│   └── entities/
│       └── time-off-request.entity.ts
├── hcm/
│   ├── hcm.module.ts
│   ├── hcm.service.ts          # HCM API client
│   └── dto/
│       └── hcm-response.dto.ts
└── sync/
    ├── sync.module.ts
    ├── sync.controller.ts      # Webhook receiver for batch sync
    ├── sync.service.ts
    └── entities/
        └── sync-log.entity.ts
```

---

## 6. Data Model

### 6.1 `time_off_balance`
Stores the locally cached balance per employee per location per leave type.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PK, auto-increment | Internal ID |
| employee_id | VARCHAR(100) | NOT NULL | Employee identifier |
| location_id | VARCHAR(100) | NOT NULL | Location identifier |
| leave_type | VARCHAR(50) | NOT NULL | e.g., "vacation", "sick", "personal" |
| balance | DECIMAL(10,2) | NOT NULL, DEFAULT 0 | Current cached balance (days) |
| pending_deductions | DECIMAL(10,2) | NOT NULL, DEFAULT 0 | Sum of approved-but-not-yet-confirmed deductions |
| last_synced_at | DATETIME | NULLABLE | Last successful sync with HCM |
| version | INTEGER | NOT NULL, DEFAULT 1 | Optimistic locking version |
| created_at | DATETIME | NOT NULL | Record creation time |
| updated_at | DATETIME | NOT NULL | Last update time |

**Unique constraint:** `(employee_id, location_id, leave_type)`

**Key design decision:** The `pending_deductions` column tracks the sum of all approved requests that haven't been confirmed by HCM yet. The **available balance** is computed as `balance - pending_deductions`. This prevents the double-spend problem at the local level.

### 6.2 `time_off_request`
Stores the full lifecycle of each time-off request.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PK, auto-increment | Internal ID |
| employee_id | VARCHAR(100) | NOT NULL | Employee identifier |
| location_id | VARCHAR(100) | NOT NULL | Location identifier |
| leave_type | VARCHAR(50) | NOT NULL | Leave type |
| start_date | DATE | NOT NULL | First day of leave |
| end_date | DATE | NOT NULL | Last day of leave |
| days_requested | DECIMAL(10,2) | NOT NULL | Number of business days |
| status | VARCHAR(30) | NOT NULL | See status enum below |
| rejection_reason | TEXT | NULLABLE | Reason if rejected |
| hcm_reference_id | VARCHAR(200) | NULLABLE | Reference ID from HCM after submission |
| idempotency_key | VARCHAR(200) | UNIQUE, NOT NULL | Client-generated key to prevent duplicate submissions |
| created_at | DATETIME | NOT NULL | Request creation time |
| updated_at | DATETIME | NOT NULL | Last update time |

**Status enum:** `PENDING` → `APPROVED` → `SUBMITTED_TO_HCM` → `CONFIRMED` | `HCM_REJECTED`  
Also: `REJECTED` (by manager), `CANCELLED` (by employee)

### 6.3 `sync_log`
Audit trail of all sync operations with HCM.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PK, auto-increment | Internal ID |
| sync_type | VARCHAR(20) | NOT NULL | "REALTIME" or "BATCH" |
| status | VARCHAR(20) | NOT NULL | "SUCCESS", "PARTIAL", "FAILED" |
| records_processed | INTEGER | DEFAULT 0 | Number of balance records processed |
| records_failed | INTEGER | DEFAULT 0 | Number of records that failed |
| error_details | TEXT | NULLABLE | Error information if applicable |
| started_at | DATETIME | NOT NULL | Sync start time |
| completed_at | DATETIME | NULLABLE | Sync completion time |

---

## 7. API Design

### 7.1 Balance Endpoints

#### `GET /api/v1/balances/:employeeId`
Returns all balances for an employee across locations and leave types.

**Query Parameters:**
- `locationId` (optional) — filter by location
- `leaveType` (optional) — filter by leave type
- `refresh` (optional, boolean) — if `true`, fetches from HCM before returning

**Response (200):**
```json
{
  "employeeId": "emp-123",
  "balances": [
    {
      "locationId": "loc-us-east",
      "leaveType": "vacation",
      "totalBalance": 10.0,
      "pendingDeductions": 2.0,
      "availableBalance": 8.0,
      "lastSyncedAt": "2026-04-10T12:00:00Z"
    }
  ]
}
```

### 7.2 Time-Off Request Endpoints

#### `POST /api/v1/time-off-requests`
Create a new time-off request.

**Request Body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "loc-us-east",
  "leaveType": "vacation",
  "startDate": "2026-05-01",
  "endDate": "2026-05-02",
  "daysRequested": 2,
  "idempotencyKey": "req-uuid-abc-123"
}
```

**Response (201):** The created request object with status `PENDING`.

**Validation (defensive, local):**
- Dates must be in the future
- `endDate >= startDate`
- `daysRequested > 0`
- Employee+location+leaveType combination must have a known balance
- `availableBalance >= daysRequested` (locally checked)

#### `GET /api/v1/time-off-requests/:id`
Get a single request by ID.

#### `GET /api/v1/time-off-requests?employeeId=X&status=Y`
List requests with optional filters.

#### `PATCH /api/v1/time-off-requests/:id/approve`
Manager approves a request. Triggers:
1. Re-validates available balance (defensive check)
2. Increments `pending_deductions` on the balance record (with optimistic lock)
3. Sets status to `APPROVED`
4. Asynchronously submits to HCM

#### `PATCH /api/v1/time-off-requests/:id/reject`
**Request Body:**
```json
{ "reason": "Team capacity is full that week" }
```
Sets status to `REJECTED`.

#### `PATCH /api/v1/time-off-requests/:id/cancel`
Employee cancels a pending or approved request. If approved, reverses `pending_deductions`.

### 7.3 Sync Endpoints

#### `POST /api/v1/sync/batch`
Webhook endpoint for HCM to push batch balance updates.

**Request Body:**
```json
{
  "balances": [
    {
      "employeeId": "emp-123",
      "locationId": "loc-us-east",
      "leaveType": "vacation",
      "balance": 15.0
    }
  ],
  "timestamp": "2026-04-10T00:00:00Z"
}
```

This endpoint upserts all balance records, preserving `pending_deductions` from in-flight requests.

#### `POST /api/v1/sync/trigger`
Manually triggers a real-time sync for a specific employee/location from HCM.

**Request Body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "loc-us-east"
}
```

---

## 8. HCM Integration & Sync Strategy

### 8.1 Two-Phase Sync Model

We employ a **two-phase approach** to keep local balances accurate:

**Phase 1 — Batch Sync (Pull):** The HCM periodically pushes the complete corpus of balances via `POST /api/v1/sync/batch`. This acts as a **reconciliation checkpoint** — it corrects any drift caused by external balance changes (anniversary bonuses, annual resets, manual HR adjustments).

**Phase 2 — Real-Time Sync (On-Demand):** When an employee views their balance with `?refresh=true`, or when a manager approves a request, we call the HCM's real-time API to get the latest balance. This ensures point-in-time accuracy for critical operations.

### 8.2 Request Submission to HCM

When a manager approves a request:

```
1. Local validation passes → status = APPROVED, pending_deductions incremented
2. Async: Call HCM real-time API to submit the deduction
   ├── Success → status = CONFIRMED, store hcm_reference_id
   │             pending_deductions decremented, balance decremented
   ├── HCM Rejects → status = HCM_REJECTED, pending_deductions reversed
   │                  Manager/employee notified
   └── Network Error → status stays SUBMITTED_TO_HCM, retry with exponential backoff
       (idempotency_key ensures no double-deduction)
```

### 8.3 Handling Batch Sync During In-Flight Requests

When a batch sync arrives:
1. For each balance record, we **upsert** the `balance` field from HCM.
2. We **do not reset** `pending_deductions` — those represent locally-approved requests not yet confirmed by HCM.
3. If the new HCM balance minus existing pending deductions goes negative, we flag a **sync conflict** in the sync log and optionally trigger a review.

### 8.4 Scheduled Jobs

The microservice runs two cron-based scheduled tasks via `@nestjs/schedule`:

| Schedule | Job | Purpose |
|---|---|---|
| **Every hour** | `scheduledBatchRefresh` | Queries all balance records where `last_synced_at` is older than 1 hour (or NULL). For each stale employee-location pair, calls the HCM real-time API to refresh the balance. This proactively catches external balance changes (anniversary bonuses, annual resets, manual HR adjustments) without waiting for the next batch push or a user-triggered refresh. |
| **Every day at midnight** | `cleanupOldSyncLogs` | Deletes `sync_log` entries older than 90 days to keep the audit trail manageable and prevent unbounded table growth. |

Both jobs are resilient — a failure syncing one employee-location pair does not block the remaining pairs, and cleanup failures are logged but do not affect service operation.

### 8.5 Idempotency

Every time-off request carries a client-generated `idempotency_key`. This key is:
- Stored in the database with a unique constraint
- Sent to the HCM as part of the deduction request
- Used to safely retry failed HCM submissions without risk of double-deduction

---

## 9. Defensive Programming & Error Handling

Since HCM validation is not guaranteed, we implement **defense-in-depth**:

### 9.1 Local Balance Validation (Layer 1)
Before any request is approved:
- Check `available_balance = balance - pending_deductions >= days_requested`
- Use **optimistic locking** (version column) to prevent race conditions on concurrent approvals

### 9.2 HCM Validation (Layer 2)
The HCM submission acts as the second validation gate. Even if our local cache is stale, the HCM should catch most invalid requests.

### 9.3 Staleness Detection (Layer 3)
- Balance records track `last_synced_at`
- If a balance hasn't been synced for a configurable threshold (e.g., 1 hour), we force a real-time sync before allowing approval
- Stale data is flagged in API responses

### 9.4 Conflict Resolution
When local and HCM state diverge:
- **HCM wins** for absolute balances (it's the source of truth)
- **Local wins** for pending deductions (HCM doesn't know about approved-but-unsubmitted requests)
- Conflicts are logged to `sync_log` for audit

### 9.5 Error Handling Strategy
| Scenario | Handling |
|---|---|
| HCM unreachable during approval | Approval proceeds locally; HCM submission retried async |
| HCM rejects after local approval | Request set to `HCM_REJECTED`; pending_deductions reversed |
| Batch sync during active request | Pending deductions preserved; new balance applied |
| Optimistic lock conflict | Request returns 409 Conflict; client retries |
| Stale balance detected | Force sync from HCM before proceeding |
| Duplicate request (same idempotency key) | Return existing request (idempotent) |

---

## 10. Security Considerations

### 10.1 Input Validation
- All DTOs validated with `class-validator` decorators
- Employee IDs, location IDs, and leave types are sanitized strings
- Date ranges are validated for logical consistency
- Numeric values (daysRequested) are bounded and positive

### 10.2 Authorization Model (Placeholder)
- Employees can only view/create/cancel their own requests
- Managers can only approve/reject requests for their direct reports
- Batch sync endpoint requires a service-to-service API key
- Implementation uses NestJS Guards; full auth integration deferred to platform team

### 10.3 Rate Limiting
- Sync trigger endpoint is rate-limited to prevent abuse
- Request creation is rate-limited per employee

### 10.4 Data Integrity
- Optimistic locking prevents race conditions
- Idempotency keys prevent duplicate operations
- Database transactions ensure atomic state changes

---

## 11. Alternatives Considered

### 11.1 Event-Driven Architecture (Rejected for MVP)

**Approach:** Use a message broker (e.g., RabbitMQ, Kafka) for all HCM communication. Balance changes published as events; microservice subscribes.

**Pros:**
- True eventual consistency with guaranteed delivery
- Better decoupling between systems
- Natural retry/dead-letter queue handling

**Cons:**
- Significant infrastructure overhead for a microservice MVP
- Added operational complexity (broker monitoring, partition management)
- HCM may not support event publishing natively

**Decision:** The current REST-based approach with async retries is sufficient for the MVP. Event-driven can be adopted later as the system scales.

### 11.2 CQRS (Command Query Responsibility Segregation) (Partially Adopted)

**Approach:** Separate read and write models — commands modify state through the HCM pipeline, queries read from the local cache.

**Pros:**
- Clean separation of concerns
- Read path can be optimized independently

**Cons:**
- Full CQRS with event sourcing adds complexity disproportionate to the domain size

**Decision:** We adopt the *spirit* of CQRS — reads serve from the local cache, writes go through validation and HCM submission — without the full event-sourcing apparatus.

### 11.3 Pessimistic Locking (Rejected)

**Approach:** Use database-level locks (SELECT FOR UPDATE) when modifying balances.

**Pros:**
- Stronger consistency guarantees
- Simpler mental model for preventing race conditions

**Cons:**
- SQLite has limited concurrent write support; pessimistic locks would serialize all operations
- Increases latency under contention
- Optimistic locking is sufficient given the expected concurrency level (per-employee operations are naturally low-contention)

**Decision:** Optimistic locking via version column. Conflicts are rare (an employee rarely submits two requests simultaneously) and cheap to retry.

### 11.4 HCM as the Only Validation Layer (Rejected)

**Approach:** Skip local balance validation entirely; always forward to HCM and rely on its response.

**Pros:**
- Simpler local logic
- Always using the source of truth for decisions

**Cons:**
- **Explicitly warned against in requirements** — HCM validation is not always guaranteed
- Adds latency to every operation (network round-trip)
- HCM outages would block all operations

**Decision:** Defense-in-depth with local validation as the first layer, HCM as the second.

### 11.5 GraphQL Instead of REST (Rejected for MVP)

**Approach:** Use GraphQL for the API layer.

**Pros:**
- Flexible queries for frontend
- Single endpoint, typed schema

**Cons:**
- The API surface is small and well-defined; REST is simpler
- Team familiarity with REST is higher
- Caching strategies for REST are more mature

**Decision:** REST with versioned endpoints (`/api/v1/`). GraphQL can be layered on top later if needed.

---

## 12. Test Strategy

### 12.1 Testing Pyramid

```
        ╱╲
       ╱ E2E ╲         Few — full HTTP lifecycle through the running app
      ╱────────╲
     ╱Integration╲     Moderate — service + DB + mock HCM server
    ╱──────────────╲
   ╱   Unit Tests    ╲  Many — pure business logic, no I/O
  ╱────────────────────╲
```

### 12.2 Mock HCM Server
A real HTTP server (using Express or NestJS) that simulates HCM behavior:
- Configurable balance responses
- Simulates deduction success/failure
- Can be set to return errors, timeouts, or unexpected responses
- Can simulate independent balance changes (anniversary bonuses)

### 12.3 Key Test Scenarios
1. **Happy path:** Create → Approve → HCM confirms → balance deducted
2. **Insufficient balance:** Local validation rejects
3. **HCM rejection after approval:** Status transitions correctly, pending_deductions reversed
4. **Concurrent requests:** Optimistic lock prevents double-spend
5. **Batch sync during in-flight request:** Pending deductions preserved
6. **HCM timeout with retry:** Idempotency key prevents double-deduction
7. **Stale balance detection:** Force sync triggered
8. **Cancellation:** Pending deductions reversed correctly
9. **Idempotent request creation:** Same key returns existing request
10. **Invalid input:** Validation rejects bad dates, negative days, missing fields

---

## 13. Non-Functional Requirements

| Requirement | Target |
|---|---|
| API response time (cached balance) | < 100ms |
| API response time (with HCM sync) | < 2s |
| Database | SQLite (single-file, zero-config) |
| Concurrent requests | Handled via optimistic locking |
| Retry policy (HCM submission) | Exponential backoff, max 3 attempts |
| Scheduled balance refresh | Every hour (stale balances > 1h) |
| Sync log retention | 90 days (auto-cleaned nightly) |

---

## 14. Future Considerations

1. **Event-Driven Sync:** Migrate to an event bus for HCM integration as the system scales.
2. **Multi-Tenant Support:** Partition data by tenant/organization for SaaS deployment.
3. **Notification Service:** Push notifications to employees/managers on status changes.
4. **Calendar Integration:** Check for public holidays and team capacity before approval.
5. **Approval Workflows:** Multi-level approval chains for extended leave.
6. **Audit Trail:** Full event-sourced audit log for compliance reporting.
