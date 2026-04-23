# UDP Multicast Nostr Testing

This document explains the two UDP multicast test scripts I built while preparing for the **Local-First Sync & Performance Engine** proposal.

The goal was not only to complete the minimum competency test, but also to extend it into something closer to the transport concerns of the proposed project. The first script validates the basic multicast loopback case on a single host. The second expands that into a more realistic sender/receiver test with explicit roles, metrics, and fallback behavior for imperfect LAN environments.

These two scripts are:

- `scripts/udp-nostr-multicast.js` — baseline self-receive sanity check
- `scripts/udp-nostr-multicast-enhanced.js` — enhanced multi-device sender/receiver metrics test

---

## Why I Built Two Versions

The original competency test asks for:

1. setting up a local Nostream development environment, and
2. writing a standalone Node.js script using `dgram` that binds to a multicast group, broadcasts a dummy Nostr event as JSON over UDP, and successfully receives and parses its own broadcast.

I completed that baseline requirement first. After that, I extended the test because the actual project needs more than “can this host send and receive one multicast packet?”

For the proposal, I wanted to validate questions that are closer to the real implementation:

- how sender and receiver roles behave across devices,
- how multicast behaves on less ideal LAN setups,
- how to detect packet loss, duplication, and parse/validation failures,
- how to design a bounded packet format with useful metadata,
- and how to gather metrics that could later inform the gossip worker design.

So the enhanced version is not a replacement for the competency test. It is an expanded version that better reflects the transport layer concerns of Phase 2.

---

## 1) Baseline Script: `udp-nostr-multicast.js`

### Purpose

This script is the minimum self-receive multicast sanity check.

It:

- joins multicast group `239.255.0.1:33333`,
- sends a dummy Nostr event as JSON,
- receives its own packet through multicast loopback,
- parses and validates the payload,
- then exits.

### Run

```bash
node scripts/udp-nostr-multicast.js
````

### Why It Matters

This script answers the simplest possible question:

> Does UDP multicast loopback work correctly on the current host?

That makes it useful as a quick yes/no environment check before debugging anything more complex.

---

## 2) Enhanced Script: `udp-nostr-multicast-enhanced.js`

### Purpose

This script extends the baseline test into a more realistic transport experiment.

It supports:

* multiple senders and receivers across devices,
* explicit runtime roles: `sender`, `receiver`, or `both`,
* multicast traffic by default,
* optional unicast fallback for networks where multicast is partially blocked,
* machine-readable summary metrics for each sender.

This makes it much closer to the kind of transport testing I would want before implementing the actual multicast worker for Nostream.

### Run Help

```bash
node scripts/udp-nostr-multicast-enhanced.js --help
```

---

## Enhanced CLI

```bash
node scripts/udp-nostr-multicast-enhanced.js [flags]
```

### Flags

* `--mode=sender|receiver|both` (default `both`)
* `--group=<multicast-ip>` (default `239.255.0.1`)
* `--port=<udp-port>` (default `33333`)
* `--bind=<bind-ip>` (default `0.0.0.0`)
* `--iface-ip=<interface-ip>` (optional membership interface)
* `--target-host=<host>` (optional unicast target)
* `--target-port=<port>` (optional; defaults to `--port` when `--target-host` is set)
* `--duration-ms=<ms>` (default `30000`)
* `--interval-ms=<ms>` (default `1000`)
* `--ttl=<0-255>` (default `1`)
* `--loopback=true|false` (default `true`)

---

## Packet Shape

Each sent datagram is UTF-8 JSON in the following structure:

```json
{
  "sender_id": "sender-<uuid>",
  "seq": 1,
  "sent_at": "2026-04-23T00:00:00.000Z",
  "transport": "multicast",
  "event": {
    "id": "<64-hex>",
    "pubkey": "<64-hex>",
    "created_at": 1776890000,
    "kind": 1,
    "tags": [["client", "udp-multicast-enhanced"]],
    "content": "dummy nostr event over udp multicast/unicast",
    "sig": "<128-hex>"
  }
}
```

### Why This Shape Was Chosen

I intentionally included:

* `sender_id` to distinguish multiple concurrent senders,
* `seq` to detect gaps and duplicates,
* `sent_at` to estimate end-to-end latency,
* `transport` to distinguish multicast from fallback unicast,
* and a Nostr-like `event` payload to stay aligned with the actual project domain.

This is not yet the final gossip-envelope design for Nostream, but it helped me think through what metadata is useful for diagnostics and later transport design.

---

## Common Test Scenarios

## Desktop sender + mobile receiver (multicast)

Desktop:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=sender
```

Mobile or another LAN device:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver
```

## Mobile sender + desktop receiver (multicast)

Desktop:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver
```

Mobile:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=sender
```

## Mixed multicast + unicast fallback

Receiver:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver --port=33333
```

Sender:

```bash
node scripts/udp-nostr-multicast-enhanced.js \
  --mode=sender \
  --target-host=<receiver-lan-ip> \
  --target-port=33333
```

In this mode, the sender transmits multicast and unicast during each interval. This is useful for testing networks where multicast is unreliable but not completely unavailable.

---

## Summary Output and Metrics

At the end of a run, the enhanced script prints one JSON block between:

* `FINAL_SUMMARY_JSON_START`
* `FINAL_SUMMARY_JSON_END`

### Included Counters

* `counters.packets_sent_total`
* `counters.packets_received_total`
* `counters.parse_errors`
* `counters.validation_errors`
* `counters.send_errors`

### Per-Sender Stats

Under `senders.<sender_id>`:

* `received_count`
* `min_seq`
* `max_seq`
* `missing_count`
* `duplicate_count`
* `validation_errors`
* `latency_ms.min`
* `latency_ms.avg`
* `latency_ms.max`
* `latency_ms.samples`

### Why These Metrics Matter

These metrics helped me test the kinds of transport questions that matter for the proposal:

* **`missing_count`** helps estimate packet loss or sequence gaps.
* **`duplicate_count`** helps detect repeated delivery.
* **`parse_errors`** shows whether non-JSON traffic or malformed datagrams are being received.
* **`validation_errors`** shows whether the datagram was JSON but not in the expected test shape.
* **latency metrics** provide a rough signal for multicast delivery timing on the LAN.

This is useful because the actual multicast worker in the proposal will need bounded packet behavior, deduplication, and debugging visibility. These experiments gave me a practical starting point for that design.

---

## Mobile and LAN Caveats

During testing, I kept the following LAN issues in mind:

* some access points or mobile hotspot networks block multicast entirely,
* AP isolation can prevent device-to-device communication on the same SSID,
* local firewalls may drop inbound UDP on the chosen port,
* hosts with multiple interfaces may join membership on the wrong NIC,
* multicast may work inconsistently even when basic connectivity exists.

That is why the enhanced script supports:

* `--iface-ip` for explicit interface membership,
* `--ttl` for bounded LAN scope,
* `--target-host` and `--target-port` for optional unicast fallback.

These options were added because I wanted the test to reflect real deployment uncertainty rather than only the best-case localhost scenario.

---

## Exit Behavior

* `0` → run completed and summary was emitted
* non-zero → startup or runtime failure, such as argument error, bind/join failure, or socket/send error

Packet loss by itself does **not** force a non-zero exit. It is reflected in the summary metrics instead.

---

## Why This Matters for the Proposal

The baseline script satisfies the minimum competency test. The enhanced script goes further and helped me think through how the actual multicast phase of the proposal should be designed.

In particular, it helped me validate and reason about:

* LAN-scoped multicast behavior with TTL,
* sender and receiver role separation,
* packet shape and metadata,
* parse and validation boundaries,
* duplicate and missing-packet detection,
* and fallback handling for imperfect local networks.

That experience directly informed my proposal decision to keep UDP multicast **small, versioned, bounded, and primarily used for discovery and event hints**, while leaving reliable synchronization and correctness to WebSockets plus NIP-77 Negentropy.
