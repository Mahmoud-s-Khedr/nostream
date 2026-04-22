This is an ambitious project—turning nostream into a commercial-grade DVM router. Let me break this into concrete, implementable phases.

## Phase 1: Add NIP-90 & NIP-89 Support to the Message Pipeline

**Step 1: Extend Event Kinds and Tags**

First, add the new event kinds to [base.ts](src/constants/base.ts#L1-L69):

```typescript
// Add to EventKinds enum
NIP90_JOB_REQUEST = 5900,
NIP90_JOB_RESULT = 6900,
NIP90_JOB_SUCCESS = 7000,
NIP90_JOB_ERROR = 7001,
NIP89_APP_HANDLER = 31989,
NIP89_APP_HANDLER_METADATA = 31990,
```

**Step 2: Create Event Strategies for DVM Messages**

Create two new files in [src/handlers/event-strategies/](src/handlers/event-strategies/):

- `nip90-job-request-strategy.ts` - Validates NIP-90 job requests, enqueues them
- `nip89-app-handler-strategy.ts` - Handles NIP-89 service advertisements

Register them in [event-strategy-factory.ts](src/factories/event-strategy-factory.ts) based on event kind.

**Step 3: Build the Job Queue**

Create `src/services/job-queue-service.ts`:

```typescript
// Use a robust queue like Bull or Agenda (Redis-backed)
// Store jobs with: jobId, pubkey, kind, params, status, result, error, createdAt, expiresAt
// Implement: enqueue, dequeue, updateStatus, getJobById, getPendingJobs
```

This queue will trap NIP-90 requests before they reach the main event pipeline.

## Phase 2: IPC Layer for External DVM Processes

**Step 1: Create IPC Worker Pool**

Create `src/ipc/dvm-worker-pool.ts`:

```typescript
// Fork external processes (Python ML models, Node scripts, etc.)
// Use standard I/O or TCP sockets for communication
// Implement: spawn, terminate, send, onMessage, healthCheck
// Add safeguards: memory limits (e.g., 512MB), timeout (e.g., 60s), sandboxing (using Node's worker_threads or Docker containers)
```

**Step 2: Create DVM Registry**

Create `src/services/dvm-registry-service.ts`:

```typescript
// Registry of active DVM capabilities: kind, name, description, inputTags, outputTags
// Methods: registerDVM, unregisterDVM, getCapabilities, getDVMForKind
```

**Step 3: NIP-89 Background Publisher**

Create `src/workers/nip89-publisher-worker.ts`:

- Publishes NIP-89 Application Handler events (kind 31989) with relay capabilities
- Sends periodic health-check heartbeats
- Withdraws events if a DVM process crashes (sends kind 5 with deletion tag)

Register this worker in [app.ts](src/app/app.ts) alongside existing workers.

## Phase 3: Saga-Pattern State Machine for Billing

This is where the magic happens—coordinating async compute with Lightning payments.

**Step 1: Extend Payment Service**

Modify [payments-service.ts](src/services/payments-service.ts#L1-L244):

```typescript
// Add methods:
// - createJobInvoice(pubkey, jobId, amount, description): Creates invoice linked to a job
// - lockJobForPayment(jobId): Locks job until payment is confirmed
// - releaseJobForCompute(jobId): Unlocks job after payment confirmation
// - failJobAndRefund(jobId, reason): Initiates refund if compute fails
```

**Step 2: Create Saga State Machine**

Create `src/services/dvm-saga-service.ts`:

```typescript
// States: PENDING_PAYMENT, PAYMENT_RECEIVED, COMPUTING, COMPLETED, FAILED, REFUNDING
// Transitions:
//   PENDING_PAYMENT -> PAYMENT_RECEIVED (payment confirmed)
//   PAYMENT_RECEIVED -> COMPUTING (start IPC worker)
//   COMPUTING -> COMPLETED (success, publish NIP-90 result)
//   COMPUTING -> FAILED (error, publish NIP-90 error, initiate refund)
//   FAILED -> REFUNDING -> REFUNDED
// 
// Use a saga orchestrator pattern: each step is idempotent, can retry
// Store state in database or Redis for durability
```

**Step 3: Integrate with Existing NWC**

The payment processor infrastructure in [payments-processors/](src/payments-processors/) already handles Lightning. You'll:

1. Link invoice IDs to job IDs
2. Use the callback routes in [routes/callbacks/](src/routes/callbacks/) to trigger saga transitions
3. Ensure the saga only proceeds to compute after payment confirmation (see [confirmInvoice](src/services/payments-service.ts#L115-L159))

## Phase 4: Architecture Integration

**Step 1: Extend Worker Model**

The [multi-process cluster model](5-primary-process-and-worker-spawning) already supports specialized workers. Add:

- `DvmOrchestratorWorker` - Manages the job queue, IPC pool, and saga orchestrator
- Register it in [app-factory.ts](src/factories/app-factory.ts)

**Step 2: Add Configuration**

Extend [settings.ts](src/@types/settings.ts) with DVM configuration:

```typescript
dvm: {
  enabled: boolean;
  maxConcurrentJobs: number;
  workerTimeout: number;
  memoryLimit: number;
  allowedKinds: number[];
  ipcMode: 'stdio' | 'tcp';
}
```

## Key Implementation Notes

1. **Memory & Sandbox Safeguards**: Use Node's `worker_threads` with `resourceLimits` or Docker containers for each DVM process. Monitor with `process.memoryUsage()`.

2. **Idempotency**: Every saga transition must be idempotent—same input → same state, no side effects on retry.

3. **Error Handling**: If IPC worker crashes → mark job FAILED → initiate refund → publish NIP-90 error.

4. **NIP-89 Heartbeats**: Publish a fresh event every 24 hours. On crash, publish a kind 5 event with `["k", "31989"]` to withdraw previous announcements.

5. **Testing**: Start with a simple DVM (e.g., text transformation) before connecting complex ML models.

---

**Where to Start:**

1. Read [Payment Service Architecture](19-payment-service-architecture) to understand the existing billing flow
2. Study [Event Message Handler](10-event-message-handler) to see how events are validated and routed
3. Check [Database Migrations](14-database-migrations-and-index-strategy) to add tables for jobs and saga state

[Architecture Overview](4-architecture-overview)
[Payment Service Architecture](19-payment-service-architecture)
[Message Handler Factory](9-message-handler-factory-and-routing)


------------------

Let me break this down into the problem, the solution, and why it works.

## The Problem

nostream is currently a Nostr relay—it stores and forwards events. It doesn't:
1. Compute anything (no ML, image processing, etc.)
2. Charge for work (only has admission fees)
3. Coordinate async jobs with payments

But Nostr has NIP-90 (Data Vending Machines) and NIP-89 (Service Discovery)—standards for relays to **advertise capabilities**, **accept job requests**, and **deliver results**. The existing codebase doesn't implement these.

## The Solution in Plain Terms

Think of this as turning nostream into:
- A **job posting board** (advertises what it can do)
- A **task dispatcher** (sends work to workers)
- A **billing department** (ensures you get paid before delivering results)

Here's how a single transaction flows:

---

## Step-by-Step Flow

### 1. User Discovers the Relay's Services (NIP-89)

**What happens:**
- The relay publishes "I can run image classification, text summarization, etc." as a kind 31989 event
- Users query relays for these announcements and find your relay

**Why it works:**
- NIP-89 is a standard—clients like Snort, Damus, or Amethyst can discover your relay's services automatically
- The background publisher keeps these announcements alive (24-hour heartbeat) and withdraws them if a DVM process crashes (kind 5 deletion event)

---

### 2. User Submits a Job Request (NIP-90)

**What happens:**
- User sends a NIP-90 job request (kind 5900) to your relay
- Example: `["EVENT", { kind: 5900, tags: [["j", "image-classify"], ["i", "base64-encoded-image"]] }]`

**How nostream handles it:**
1. The [WebSocketAdapter](src/adapters/web-socket-adapter.ts#L144-L204) receives the message
2. [messageHandlerFactory](src/factories/message-handler-factory.ts#L15-L31) routes to `EventMessageHandler`
3. A new `Nip90JobRequestStrategy` intercepts it (instead of just storing it like [default-event-strategy](src/handlers/event-strategies/default-event-strategy.ts))
4. The request is validated and enqueued in the job queue

**Why it works:**
- The existing [EventMessageHandler](src/handlers/event-message-handler.ts#L54-L129) already has validation, rate limiting, and admission checks
- We're just adding a **new strategy** for NIP-90 events (see [event-strategy-factory](src/factories/event-strategy-factory.ts))
- The job queue ensures requests don't get lost and can be retried

---

### 3. Relay Creates an Invoice (Billing Gateway)

**What happens:**
- The saga state machine receives the job request
- It calculates the cost (e.g., 1000 sats for image classification)
- It calls `paymentsService.createInvoice()` using the existing [LnurlPaymentsProcessor](src/payments-processors/lnurl-payments-processor.ts#L29-L69) or any other payment processor

**Why it works:**
- The [PaymentsService](src/services/payments-service.ts#L59-L110) already handles invoice creation, status updates, and confirmation
- We're extending it to link invoices to job IDs
- The callback routes in [routes/callbacks/](src/routes/callbacks/) already handle payment confirmations—we just trigger saga transitions instead

---

### 4. User Pays (Lightning Network)

**What happens:**
- User scans QR code, pays invoice via their Lightning wallet
- Payment processor (e.g., lnurl) confirms payment
- Callback webhook hits your relay → saga transitions to `PAYMENT_RECEIVED`

**Why it works:**
- This is already implemented—see [getInvoice](src/services/payments-service.ts#L26-L33) and [confirmInvoice](src/services/payments-service.ts#L115-L159)
- We're hooking into this flow, not replacing it

---

### 5. Saga Transitions to Computing (Payment Confirmed)

**What happens:**
- Saga state: `PENDING_PAYMENT` → `PAYMENT_RECEIVED`
- Saga spawns an IPC worker (e.g., a Python script for image classification)
- Job is locked so payment can't be refunded while computing

**Why the saga pattern matters:**
- Distributed systems fail. If the IPC worker crashes, the saga must know to:
  - Mark job as `FAILED`
  - Publish NIP-90 error event
  - Initiate refund
- Each transition is **idempotent**—same input → same state, even if retried
- This prevents double-charging, lost payments, or undelivered results

---

### 6. IPC Worker Computes the Result

**What happens:**
- The IPC pool (using Node's `worker_threads` or Docker) spawns a process
- It sends the job parameters via stdin or TCP socket
- Worker runs: `python classify_image.py --input base64-encoded-image`
- Worker outputs: `{"label": "cat", "confidence": 0.95}`

**Why safeguards are needed:**
- ML models can consume unlimited memory or hang forever
- We enforce:
  - Memory limits (e.g., 512MB per worker)
  - Timeout (e.g., 60s → kill worker)
  - Sandbox (Docker or `worker_threads` with resource limits)
- This prevents a malicious job from crashing the entire relay

---

### 7. Saga Transitions to Completed (Result Ready)

**What happens:**
- Worker returns result → saga receives it
- Saga state: `COMPUTING` → `COMPLETED`
- Saga publishes NIP-90 job result event (kind 6900 or 7000)

**Example result event:**
```json
{
  "kind": 7000,
  "tags": [
    ["j", "job-id"],
    ["status", "success"],
    ["result", "{\"label\":\"cat\",\"confidence\":0.95}"]
  ]
}
```

**Why it works:**
- NIP-90 defines standard result formats—clients can parse them automatically
- The result is stored in the relay like any other event (via [event-repository](src/repositories/event-repository.ts))
- User can query for results by job ID

---

### 8. User Receives the Result

**What happens:**
- User's Nostr client filters for NIP-90 result events by job ID
- Result is delivered via WebSocket (like [onBroadcast](src/adapters/web-socket-adapter.ts#L102-L111))
- User sees: "Classification: cat (95% confidence)"

**Why it works:**
- The relay already broadcasts events to subscribed clients
- We're just publishing a different kind of event (NIP-90 results)
- Clients filter by job ID to find their specific result

---

## Why This Architecture Works

### 1. Extends Existing Infrastructure

You're not rebuilding nostream—you're **extending** it:
- [Message Handler Factory](src/factories/message-handler-factory.ts) already routes events by type
- [PaymentsService](src/services/payments-service.ts) already handles Lightning
- [EventMessageHandler](src/handlers/event-message-handler.ts) already validates, rate-limits, and admits users

You're adding:
- New event kinds (NIP-90, NIP-89)
- New strategies for those kinds
- A saga orchestrator on top

---

### 2. Decouples Compute from Relay

The IPC worker pool runs DVM processes **separately** from the relay:
- Relay stays fast (no blocking computations on main thread)
- Workers can be written in any language (Python, Rust, Go)
- Crashes don't take down the relay

---

### 3. Ensures Reliable Billing

The saga pattern guarantees:
- **No double charging** (each state transition is idempotent)
- **No lost payments** (state persisted in database/Redis)
- **Refunds on failure** (automatic if compute fails)
- **No results without payment** (saga blocks compute until confirmed)

---

### 4. Standards-Based

NIP-90 and NIP-89 are open standards:
- Any Nostr client can discover your relay's services
- Anyone can submit jobs (if they pay)
- Results are portable (clients can switch relays)

---

## Real-World Example

**Scenario:** User wants to classify an image

| Step | What Happens | Who Does It |
|------|--------------|-------------|
| 1 | User searches for image classification services | Client queries NIP-89 events |
| 2 | Finds your relay advertising "image-classify" | NIP-89 background publisher |
| 3 | Sends job request with image data | User's client → your relay |
| 4 | Validates request, enqueues job | Nip90JobRequestStrategy |
| 5 | Creates 1000 sats invoice | PaymentsService |
| 6 | User pays invoice | Lightning wallet |
| 7 | Confirms payment, spawns worker | Saga → IPC pool |
| 8 | Worker classifies image | Python script (sandboxed) |
| 9 | Returns result → saga completes | IPC pool → saga |
| 10 | Publishes result event | Saga → relay |
| 11 | User receives classification | Relay → client |

**Total time:** ~2-5 seconds (mostly Lightning confirmation + compute)

---

## Why This Matters

Without this:
- Relays are just dumb storage → no revenue from compute
- DVMs can't charge reliably → payment disputes, lost revenue
- No service discovery → users can't find capabilities

With this:
- Relays become **commercial compute platforms**
- Payments are **atomic** (pay → compute → result or refund)
- Services are **self-advertising** (NIP-89)

---

## Where to Start Coding

1. **Add event kinds** to [base.ts](src/constants/base.ts) (5 minutes)
2. **Create job queue table** (new migration) (15 minutes)
3. **Implement Nip90JobRequestStrategy** (1-2 hours)
4. **Build IPC worker pool** (2-3 hours)
5. **Extend PaymentsService** for job invoices (1 hour)
6. **Create saga state machine** (3-4 hours)
7. **Write end-to-end test** with a simple DVM (2 hours)

Total: ~10-12 hours for a basic working prototype.

[Payment Service Architecture](19-payment-service-architecture)
[Event Message Handler](10-event-message-handler)
[Factory Pattern](16-factory-pattern-and-dependency-injection)
