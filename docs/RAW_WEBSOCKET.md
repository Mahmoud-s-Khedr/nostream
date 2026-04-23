# Competency Test: Raw WebSocket Interaction with Nostream (`wscat`, `nak`, and TypeScript)

This document is one of my competency-test artifacts for Nostream. Its purpose is to demonstrate that I can:

1. run a local Nostream development environment,
2. connect to the relay using raw WebSocket clients,
3. send valid and invalid Nostr protocol messages,
4. observe and explain the relay’s responses,
5. and reason about the protocol behavior that the main proposal will build on.

This is directly relevant to the **Local-First Sync & Performance Engine** proposal because both the current relay behavior and the proposed NIP-77 synchronization flow depend on understanding raw relay message exchange over WebSockets.

---

## What This Competency Test Demonstrates

This competency test focuses on raw relay interaction rather than application-level abstractions.

Specifically, it demonstrates:

- connecting to a local Nostream instance through WebSocket,
- issuing NIP-01-style relay messages such as `REQ`, `EVENT`, `CLOSE`, and `COUNT`,
- verifying expected relay responses such as `EVENT`, `EOSE`, `OK`, `NOTICE`, and `CLOSED`,
- understanding how the relay behaves for both valid and intentionally invalid frames,
- and using three different client approaches:
  - `wscat`,
  - `nak`,
  - and a custom TypeScript script.

This matters for the proposal because the project is not only about database work. It also relies on protocol correctness, transport behavior, and later relay-to-relay WebSocket interactions.

---

## Defaults Used in This Repository

The following defaults are used in this test setup:

- **Local relay endpoint:** `ws://localhost:8008`
- **Default relay port:** `8008`
- **Inbound client messages supported by this relay:** `REQ`, `EVENT`, `CLOSE`, `COUNT`
- **Outbound relay messages observed in this test:** `EVENT`, `EOSE`, `OK`, `NOTICE`, `CLOSED`

NIP-42 `AUTH` is intentionally not part of this demo because it is not needed for the competency test goals here.

---

## Prerequisites

Start Nostream first, for example with:

```bash
./scripts/start
````

or

```bash id="5vl1vt"
npm run dev
```

Then export the relay URL:

```bash id="x1lqxu"
export RELAY_URL='ws://localhost:8008'
```

Install the raw clients if they are missing.

### `wscat`

```bash id="41zlxw"
npm install -g wscat
```

### `nak`

```bash id="9kiupu"
go install github.com/fiatjaf/nak@latest
export PATH="$PATH:$(go env GOPATH)/bin"
```

---

## TypeScript Raw WebSocket Demo

This repository includes a runnable raw WebSocket demo script:

* `scripts/raw-websocket-demo.ts`

This script demonstrates:

* opening a raw WebSocket connection to the relay,
* sending a `REQ` and waiting for `EOSE`,
* sending an intentionally invalid `REQ` and waiting for `NOTICE`,
* sending `CLOSE` for the active subscription,
* and optionally publishing a signed event and waiting for an `OK` response.

### Run with npm

```bash id="jlwmst"
npm run demo:raw-ws
```

### Run directly

```bash id="dzkcl9"
node -r ts-node/register scripts/raw-websocket-demo.ts
```

### Common options

```bash id="ggvfi8"
npm run demo:raw-ws -- \
  --relay-url ws://localhost:8008 \
  --sub-id ts-demo-sub \
  --kind 1 \
  --limit 3 \
  --timeout-ms 10000
```

### Filter by author

```bash id="ngp0ou"
npm run demo:raw-ws -- --author <pubkey_hex>
```

### Skip invalid-message check

```bash id="t0tcpm"
npm run demo:raw-ws -- --skip-invalid
```

### Print all options

```bash id="icv6x2"
npm run demo:raw-ws -- --help
```

### Optional publish path

1. Put a fully signed Nostr event JSON object in a file, for example `./event.json`
2. Run:

```bash id="55ylu9"
npm run demo:raw-ws -- --event-json ./event.json
```

### Expected output shape

The script prints raw frame flow in a debugging-friendly format:

* outbound frames are prefixed with `-->`
* inbound frames are prefixed with `<--`

For a normal subscription flow, I expect to see:

* zero or more `EVENT` messages,
* followed by `EOSE` for the same subscription ID.

For the intentionally invalid `REQ`, I expect to see:

* a `NOTICE` response describing why the request is invalid.

This script helped me verify relay behavior at the frame level instead of only through higher-level clients.

---

## `wscat` Demo

This is the most direct way to inspect raw relay frames manually.

### Connect

```bash id="vdrpxz"
wscat -c "$RELAY_URL"
```

### Send a valid subscription request

```json id="3zufdb"
["REQ","demo-sub",{"kinds":[1],"limit":3}]
```

### Expected response pattern

I expect one of these patterns:

* one or more:

  ```json
  ["EVENT","demo-sub",{...}]
  ```
* followed by:

  ```json
  ["EOSE","demo-sub"]
  ```

This confirms that the relay:

* accepted the subscription,
* streamed matching stored events,
* and marked the end of stored results correctly.

### Send an intentionally invalid message

```json id="4nhw6d"
["REQ","broken"]
```

### Expected response

```json id="7t7pha"
["NOTICE","invalid: REQ message must contain at least one filter"]
```

This validates that the relay rejects malformed requests explicitly rather than failing silently.

### Unsubscribe cleanly

```json id="0gh2jn"
["CLOSE","demo-sub"]
```

### Notes

* `CLOSE` removes the subscription.
* This relay does not send a `CLOSED` acknowledgement for a normal `CLOSE`.
* In this relay, `CLOSED` is used for failed or disabled `COUNT` requests.

### Optional `COUNT` check

```json id="t1bapp"
["COUNT","count-1",{"kinds":[1]}]
```

### Expected response

Either:

```json id="j3b5oc"
["COUNT","count-1",{"count":<number>}]
```

or, if the feature is disabled or rejected by configuration:

```json id="jlwmgc"
["CLOSED","count-1","<reason>"]
```

This is useful because it demonstrates that I understand not only the happy path but also the relay’s behavior when a feature is unavailable.

---

## `nak` Demo

`nak` provides another way to interact with the relay over WebSocket from the command line.

### Read-only subscription with an equivalent filter

```bash id="rrq9ey"
nak req -k 1 -l 3 "$RELAY_URL"
```

### Query by author

```bash id="szdfk3"
nak req -k 1 -a <pubkey_hex> -l 5 "$RELAY_URL"
```

### Optional publish test

```bash id="jz73fc"
nak event --sec <hex_or_nsec_private_key> -k 1 -c 'hello from nak' "$RELAY_URL"
```

### Expected publish behavior

For a valid signed event, I expect an `OK` result with `accepted=true`.

For an invalid event or invalid signature, I expect an `OK` result with `accepted=false` and an `invalid: ...` reason.

This is useful because it verifies that the relay’s publish path and validation path are exposed correctly to raw clients.

---

## Why This Matters for My Proposal

This competency test is relevant to the proposal for three reasons.

### 1. It validates relay protocol understanding

My proposal depends on understanding how Nostream behaves at the raw message level, not only through abstractions. That includes request validation, stored-event delivery, end-of-stream signaling, and publish acknowledgements.

### 2. It helps with future relay-to-relay flows

Although this competency test only covers current raw WebSocket interaction, it directly supports later work in the proposal. NIP-77 reconciliation will also operate over WebSocket message exchange, so being comfortable with raw relay frames is important.

### 3. It complements the multicast competency work

The project has both:

* a WebSocket-based correctness and synchronization side, and
* a UDP multicast local-propagation side.

This document covers the WebSocket side of that foundation, while my UDP multicast testing covers the LAN transport side.

Together, they gave me a practical starting point for the proposal instead of relying only on documentation or high-level architecture reading.

---

## Summary

This competency-test artifact demonstrates that I can:

* run a local Nostream environment,
* connect to it with raw WebSocket clients,
* issue valid and invalid relay messages,
* interpret relay responses correctly,
* and verify expected protocol behavior using `wscat`, `nak`, and a custom TypeScript script.

That experience is directly useful for the proposed project because the Local-First Sync & Performance Engine builds on both relay message correctness and deeper transport behavior.
