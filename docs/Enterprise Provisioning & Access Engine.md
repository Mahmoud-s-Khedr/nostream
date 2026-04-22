# Working on the Enterprise Provisioning & Access Engine

This is a substantial feature that adds enterprise-grade access control to nostream. Let me break it down into manageable pieces.

## Task Overview

You're building a complete permissioned access layer with four components:
1. **NIP-42** (WebSocket Auth) - Challenge-response authentication for WebSocket connections
2. **NIP-70** (Protected Events) - Event-level authorization for protected content
3. **NIP-43** (Access Provisioning) - Automated tier-based access management
4. **NIP-98** (HTTP Auth) - Cryptographic token authentication for REST API

## Implementation Strategy

### Phase 1: Foundation - Session State Management

**Create a session repository** to track authenticated WebSocket connections:

```typescript
// src/repositories/session-repository.ts
export class SessionRepository {
  // Store: clientId -> { pubkey, authenticatedAt, challenge, accessTier, expiresAt }
}
```

**Key modifications:**
- Extend [WebSocketAdapter](src/adapters/web-socket-adapter.ts#L30-L259) to hold session state
- Add session metadata to the adapter's context
- Create database migration for sessions table (or use Redis for ephemeral sessions)

### Phase 2: NIP-42 Implementation

**Where to start:**
1. Modify [web-socket-server-adapter.ts](src/adapters/web-socket-server-adapter.ts#L88-L102) - The `onConnection` method is your entry point
2. Create `src/handlers/auth-message-handler.ts` - New message handler for AUTH messages
3. Update [message-handler-factory.ts](src/factories/message-handler-factory.ts#L22-L52) to route AUTH messages

**Implementation flow:**
```typescript
// 1. Server sends challenge on connection (random string)
// 2. Client responds with AUTH message (event signed with challenge)
// 3. Verify signature, mark session as authenticated
// 4. Store pubkey and access tier in session state
```

**Add to constants:**
```typescript
// src/constants/base.ts
export enum EventKinds {
  // ... existing
  AUTHENTICATION = 22242,  // NIP-42 AUTH event kind
  ACCESS_REQUEST = 843,   // NIP-43 access request
}
```

### Phase 3: NIP-70 Protected Events

**Where to integrate:**
- Modify [event-message-handler.ts](src/handlers/event-message-handler.ts#L135-L224) - The `canAcceptEvent` method
- Add protected event check before event validation

**Implementation:**
```typescript
// Add to event-message-handler.ts
protected async isProtectedEvent(event: Event): Promise<boolean> {
  // Check if event kind is in protected list (configurable)
  // Check event tags for 'p' or 'r' restrictions
}

protected async hasAccessToProtectedEvent(
  event: Event, 
  session: Session | undefined
): Promise<boolean> {
  // Verify session exists and is authenticated
  // Check if session's pubkey matches allowed recipients
  // Check access tier requirements
}
```

**Integration point:**
Add this check in [handleMessage](src/handlers/event-message-handler.ts#L54-L129) before `isEventValid`.

### Phase 4: NIP-43 Access Provisioning

**Create new components:**
1. `src/services/access-provisioning-service.ts` - State machine for tier management
2. `src/controllers/access/access-request-controller.ts` - Handle kind 843 events
3. `src/routes/access/index.ts` - New route for access management

**State machine logic:**
```typescript
// Access tiers: GUEST → REQUESTED → PENDING → APPROVED → REVOKED

class AccessProvisioningService {
  async handleAccessRequest(event: Event) {
    // Parse kind 843 event
    // Check if user is authenticated (NIP-42)
    // Determine requested tier from event content/tags
    // Update state based on rules (auto-approve or manual review)
    // Send notification event to relay operator
  }
  
  async grantAccess(pubkey: string, tier: AccessTier) {
    // Update user's access tier in session/database
    // Broadcast change to all connected workers
  }
}
```

**Add to [routes/index.ts](src/routes/index.ts#L1-L37):**
```typescript
import accessRouter from './access'
router.use('/access', rateLimiterMiddleware, accessRouter)
```

### Phase 5: NIP-98 HTTP Authentication

**Create middleware:**
```typescript
// src/handlers/request-handlers/nip98-auth-middleware.ts
export async function nip98AuthMiddleware(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  // Extract Authorization header
  // Verify JWT signature against nostr event
  // Check payload: method, url, body hash
  // Attach pubkey to request context
}
```

**Create admin API routes:**
```typescript
// src/routes/admin/index.ts
router.post('/config/reload', nip98AuthMiddleware, reloadConfigController)
router.post('/access/:pubkey/grant', nip98AuthMiddleware, grantAccessController)
router.get('/sessions', nip98AuthMiddleware, listSessionsController)
```

**Hot-reload configuration:**
Extend [settings-factory.ts](src/factories/settings-factory.ts) to support dynamic reloading from database or file system.

## Integration Points Summary

| Component | File to Modify | Purpose |
|-----------|---------------|---------|
| Session State | [web-socket-adapter.ts](src/adapters/web-socket-adapter.ts#L36-L259) | Hold auth state per connection |
| AUTH Handler | [message-handler-factory.ts](src/factories/message-handler-factory.ts#L22-L52) | Route AUTH messages |
| Event Filter | [event-message-handler.ts](src/handlers/event-message-handler.ts#L135-L224) | Drop unauthorized protected events |
| Access Control | [routes/index.ts](src/routes/index.ts#L1-L37) | Add new admin/access routes |
| Config System | [settings-factory.ts](src/factories/settings-factory.ts) | Enable hot-reload |

## Configuration Additions

Extend [settings.ts](src/@types/settings.ts#L1-L100):
```typescript
export interface AccessControlSettings {
  enableNip42Auth: boolean
  protectedEventKinds: EventKinds[]
  accessTiers: {
    [tierName: string]: {
      allowedKinds: EventKinds[]
      maxDailyEvents: number
    }
  }
  autoApproveAccess: boolean
  nip98Enabled: boolean
  authorizedAdmins: Pubkey[]
}
```

## Testing Strategy

1. **Unit tests**: Test session management, auth verification, access tier logic
2. **Integration tests**: Test full AUTH flow, protected event rejection
3. **E2E tests**: Use [cucumber.js](cucumber.js) to write scenario tests
4. **Security tests**: Verify token expiry, replay protection, signature validation

## Implementation Order

1. **Start with session foundation** (no NIP-specific logic yet)
2. **Implement NIP-42** first (auth is prerequisite for others)
3. **Add NIP-70** protected event filtering
4. **Build NIP-43** provisioning system
5. **Finish with NIP-98** admin API

## Recommended Next Steps

- [Architecture Overview](4-architecture-overview) - Understand the multi-process model
- [WebSocket Worker](6-websocket-worker) - See how connections are managed
- [Message Handler Factory and Routing](9-message-handler-factory-and-routing) - Learn the routing pattern
- [Configuration Reference](24-configuration-reference) - Understand current config system

The beauty of this architecture is that you can implement these incrementally without breaking existing functionality. Each NIP builds on the previous one, so test thoroughly at each stage.

------


# How and Why the Enterprise Provisioning Engine Works

Let me walk you through the technical logic and design rationale.

---

## The Core Problem nostream Solves Today

Right now, nostream is **open by design**. Look at the [event-message-handler](src/handlers/event-message-handler.ts#L135-L224) - the `canAcceptEvent()` method checks things like:
- Is the event signature valid?
- Is the event expired?
- Is the rate limit exceeded?
- Is the user vanished (NIP-62)?

But there's **no notion of "who you are"** - only "is this event valid?". Every connection is treated identically. That's great for a public relay, but useless for enterprise use cases where you need:
- **Authentication** - Prove you're who you say you are
- **Authorization** - Prove you're allowed to do this
- **Stateful access** - Remember who you are across messages
- **Dynamic control** - Change rules without restarting

The four NIPs solve these in a layered way.

---

## Layer 1: NIP-42 - WebSocket Authentication (Identity)

### How It Works

```
1. Client connects to WebSocket
   ↓
2. Server sends "AUTH" challenge (random string)
   ↓
3. Client signs challenge with their private key
   ↓
4. Client sends AUTH event: { kind: 22242, tags: [['challenge', 'abc123']], content: '', signature: '...' }
   ↓
5. Server verifies:
   - Event is signed correctly
   - challenge tag matches what server sent
   - pubkey extracted from signature
   ↓
6. Session marked as authenticated with that pubkey
```

### Why This Approach

**Why not just pass a token?** Because Nostr's entire security model is built on cryptographic keys. NIP-42 leverages the same keys users already have - no extra credentials to manage.

**Where it fits in nostream:**
- [web-socket-server-adapter.ts](src/adapters/web-socket-server-adapter.ts#L88-L102) creates connections
- [web-socket-adapter.ts](src/adapters/web-socket-adapter.ts#L36-L259) wraps each connection
- Right now, `WebSocketAdapter` has no concept of "who owns this socket"
- You add `session: Session | undefined` to track this state

**The session state is the key insight** - it transforms a stateless WebSocket into a stateful, authenticated channel. Every message after AUTH comes with implicit context: "this is from pubkey X".

---

## Layer 2: NIP-70 - Protected Events (Authorization)

### How It Works

NIP-70 defines events that require authorization. The relay checks access before accepting:

```
Event arrives → Check if protected → Check session auth → Check access tier → Accept or Reject
```

In code, this becomes a guard in [event-message-handler.ts](src/handlers/event-message-handler.ts#L54-L129):

```typescript
async handleMessage(message: IncomingEventMessage) {
  const event = message[1]
  
  // NEW: Check if this event is protected
  if (this.isProtectedEvent(event)) {
    const session = this.webSocket.getSession()
    if (!session || !session.isAuthenticated) {
      return this.webSocket.send(['OK', event.id, false, 'restricted: auth required'])
    }
    
    if (!this.hasAccessTier(session, event.kind)) {
      return this.webSocket.send(['OK', event.id, false, 'restricted: insufficient tier'])
    }
  }
  
  // Continue with existing validation...
}
```

### Why This Approach

**Why check at event ingestion?** Because that's nostream's choke point. Every event goes through [event-message-handler](src/handlers/event-message-handler.ts#L42-L476) - it's the single place to enforce policy. Adding the check here means:
- Protected events never hit the database
- No need for database-level access controls
- Clean separation: "auth here, persistence there"

**Why not use existing rate limiting?** Rate limiting is about *volume*, not *access*. You can rate-limit someone while still denying them entirely for certain operations. NIP-70 is binary: either you can publish this event kind or you can't.

**The elegance:** NIP-70 doesn't require protocol changes - it's purely relay-side policy. Clients don't need to know an event is protected; they just get an `OK` or `NOT OK` response.

---

## Layer 3: NIP-43 - Automated Access Provisioning (Lifecycle)

### How It Works

NIP-43 defines **access request events** (kind 843) that let clients request tier changes. The relay runs a state machine:

```
Client sends kind 843: { content: 'requesting paid tier', tags: [['tier', 'premium']] }
   ↓
State machine processes:
  1. Parse request (tier requested, justification, etc.)
  2. Check if user is authenticated (NIP-42)
  3. Apply business rules (auto-approve? require review?)
  4. Update user's access tier in database
  5. Notify client of decision
```

### Why This Approach

**Why automate this?** Manual access management doesn't scale. An enterprise relay with thousands of users needs:
- Self-service tier upgrades
- Automated approval workflows
- Clear audit trails

**Why use Nostr events for access requests?** Because:
- They're cryptographically signed (non-repudiable)
- They can be stored and replayed (audit log)
- They fit the existing event pipeline
- Clients already know how to send events

**The state machine pattern** is ideal here because access provisioning has clear states:
```
GUEST → REQUESTED → PENDING → APPROVED → ACTIVE → EXPIRED → REVOKED
```

Each transition can trigger side effects:
- Send notification to admin
- Update balance (if paid tier)
- Broadcast tier change to all workers
- Log for compliance

**Where it integrates:**
- New message handler for kind 843 (like [subscribe-message-handler](src/handlers/subscribe-message-handler.ts))
- [message-handler-factory](src/factories/message-handler-factory.ts#L22-L52) routes it
- State logic lives in a service (separation of concerns)

---

## Layer 4: NIP-98 - HTTP Authentication (Admin Control)

### How It Works

NIP-98 defines HTTP auth using Nostr-signed JWTs:

```
1. Admin creates JWT payload: { method: 'POST', url: '/admin/config/reload', body_hash: '...', iat: timestamp }
2. Admin signs JWT with private key (same as NIP-42)
3. Admin sends: Authorization: Bearer <jwt>
4. Relay middleware verifies:
   - JWT signature valid
   - method matches request
   - URL matches request
   - body hash matches
   - pubkey is in authorizedAdmins list
5. Request proceeds
```

### Why This Approach

**Why use Nostr keys for HTTP auth?** Because:
- Admins already have Nostr keys (single credential)
- No need for OAuth, API keys, or password auth
- Cryptographically verifiable
- Time-bound (iat prevents replay)

**Why hot-reloadable config?** Because:
- Restarting a relay drops all connections (bad)
- Multi-process clusters need config sync
- Enterprises need instant policy changes

**The middleware pattern** fits Express/Fastify naturally. Look at [rate-limiter-middleware.ts](src/handlers/request-handlers/rate-limiter-middleware.ts#L12-L44) - NIP-98 middleware works the same way: check, attach context, proceed or reject.

**Admin API endpoints:**
- `POST /admin/config/reload` - Pull new config from DB/file
- `POST /admin/access/:pubkey/grant` - Manually grant tier
- `GET /admin/sessions` - List active authenticated sessions
- `POST /admin/rules/add` - Add new protected event kind

---

## How All Layers Fit Together

```
┌─────────────────────────────────────────────────────────────┐
│                     Incoming Event                          │
│              (kind 1, kind 843, kind 22242, etc.)           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────┐
        │  messageHandlerFactory   │  Routes by message type
        └────────┬─────────────────┘
                 │
    ┌────────────┴────────────┐
    │                         │
    ▼                         ▼
┌──────────────┐      ┌──────────────┐
│   AUTH       │      │   EVENT      │
│   Handler    │      │   Handler    │
│  (NIP-42)    │      │              │
└──────┬───────┘      └──────┬───────┘
       │                     │
       │ Updates session      │ Checks if protected
       │ state on adapter    │ (NIP-70)
       │                     │
       ▼                     ▼
┌─────────────────────────────────────────┐
│         WebSocketAdapter                 │
│  { session: { pubkey, tier, authAt } } │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│    Session State (Redis/Database)        │
│  Tracks auth state per connection ID     │
└─────────────────────────────────────────┘
```

---

## Why This Architecture Works

### 1. **Leverages Existing Patterns**

The design follows nostream's current architecture:
- Message handlers for protocol messages ✓ ([subscribe-message-handler](src/handlers/subscribe-message-handler.ts))
- Factory pattern for dependencies ✓ ([message-handler-factory](src/factories/message-handler-factory.ts))
- Repository pattern for data access ✓ ([user-repository](src/repositories/user-repository.ts))
- Middleware for HTTP routes ✓ ([rate-limiter-middleware](src/handlers/request-handlers/rate-limiter-middleware.ts))

You're not reinventing the wheel - you're adding new gears to the same machine.

### 2. **State is Local to Connections**

Session state lives in [WebSocketAdapter](src/adapters/web-socket-adapter.ts), not in a global map. This means:
- No cross-worker contention
- Natural cleanup when connection closes
- Works in multi-process clusters without shared memory

For cross-worker sync (like tier changes), use Redis pub/sub or database triggers.

### 3. **Zero Breaking Changes**

None of this requires client protocol changes:
- Clients that don't AUTH work as before (treated as GUEST tier)
- Protected events just get `OK, false` responses
- Existing routes continue working
- You can disable all NIPs and revert to vanilla nostream

### 4. **Cryptographic Security by Design**

All auth is based on Nostr's cryptographic foundation:
- NIP-42: Event signatures prove identity
- NIP-98: JWTs are Nostr-signed payloads
- NIP-43: Access requests are signed events

No passwords, no secrets to leak, no token rotation headaches.

### 5. **Enterprise-Grade Features**

This design delivers enterprise needs:
- **Audit trail**: Every auth attempt, access request, and tier change is an event
- **Fine-grained control**: Protect specific event kinds, not all-or-nothing
- **Dynamic reconfiguration**: Change rules without downtime
- **Multi-tier access**: Support free/paid/premium tiers naturally

---

## The "Aha" Insight

The key insight is that **Nostr events are a general-purpose signed message format**, not just "social network posts". 

By treating authentication, access requests, and admin commands as events, you get:
- Cryptographic verification for free
- Built-in replay protection (nonces/timestamps)
- Compatibility with existing event infrastructure
- A single credential model (pubkey/privkey)

This isn't just "adding auth to nostream" - it's recognizing that the protocol itself is designed for this kind of use case. The four NIPs aren't random; they form a coherent access control system that fits Nostr's architecture like a glove.

---

## Where to Start Understanding

If you want to grok this deeply:

1. **Read the WebSocket adapter code** - See how connections are wrapped and managed
2. **Trace an EVENT message** - Follow from [message-handler-factory](src/factories/message-handler-factory.ts#L22-L52) → [event-message-handler](src/handlers/event-message-handler.ts#L54-L129) → database
3. **Study the rate limiter middleware** - It's the same pattern you'll use for NIP-98
4. **Look at the payment system** - It already has tiers/billing logic you can adapt

The architecture is solid. The challenge is not "will this work?" but "how do we implement this cleanly?" And that's a much better problem to have.
