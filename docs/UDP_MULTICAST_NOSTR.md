# UDP Multicast Nostr Testing

This document explains both UDP scripts:

- `scripts/udp-nostr-multicast.js` (baseline self-receive sanity check)
- `scripts/udp-nostr-multicast-enhanced.js` (multi-device sender/receiver metrics test)

## Script Overview

### 1) Baseline: `udp-nostr-multicast.js`

Purpose:

- one-process local sanity check
- join multicast group `239.255.0.1:33333`
- send a dummy Nostr event
- receive its own packet via multicast loopback
- parse/validate payload and exit

Run:

```bash
node scripts/udp-nostr-multicast.js
```

Use this when you want a quick yes/no check that multicast loopback works on the current host.

### 2) Enhanced: `udp-nostr-multicast-enhanced.js`

Purpose:

- test multiple senders/receivers across devices
- support explicit roles: `sender`, `receiver`, `both`
- send multicast traffic by default
- optionally also send unicast (`--target-host`, `--target-port`) for networks where multicast is partially blocked
- collect machine-readable metrics per sender

Run help:

```bash
node scripts/udp-nostr-multicast-enhanced.js --help
```

## Enhanced CLI

```bash
node scripts/udp-nostr-multicast-enhanced.js [flags]
```

Flags:

- `--mode=sender|receiver|both` (default `both`)
- `--group=<multicast-ip>` (default `239.255.0.1`)
- `--port=<udp-port>` (default `33333`)
- `--bind=<bind-ip>` (default `0.0.0.0`)
- `--iface-ip=<interface-ip>` (optional membership interface)
- `--target-host=<host>` (optional unicast target)
- `--target-port=<port>` (optional; defaults to `--port` when `--target-host` is set)
- `--duration-ms=<ms>` (default `30000`)
- `--interval-ms=<ms>` (default `1000`)
- `--ttl=<0-255>` (default `1`)
- `--loopback=true|false` (default `true`)

## Packet Shape (Enhanced Script)

Each sent datagram is UTF-8 JSON:

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

## Common Scenarios

### Desktop sender + mobile receiver (multicast)

Desktop:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=sender
```

Mobile (or another device on same LAN):

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver
```

### Mobile sender + desktop receiver (multicast)

Desktop:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver
```

Mobile:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=sender
```

### Mixed multicast + unicast fallback

Receiver host:

```bash
node scripts/udp-nostr-multicast-enhanced.js --mode=receiver --port=33333
```

Sender host:

```bash
node scripts/udp-nostr-multicast-enhanced.js \
  --mode=sender \
  --target-host=<receiver-lan-ip> \
  --target-port=33333
```

In this mode, sender transmits multicast and unicast each interval.

## Summary Output And Metrics

At the end of a run, the enhanced script prints one JSON block between:

- `FINAL_SUMMARY_JSON_START`
- `FINAL_SUMMARY_JSON_END`

The summary includes:

- `counters.packets_sent_total`
- `counters.packets_received_total`
- `counters.parse_errors`
- `counters.validation_errors`
- `counters.send_errors`
- per-sender stats under `senders.<sender_id>`:
- `received_count`
- `min_seq`, `max_seq`
- `missing_count` (inferred from observed sequence range)
- `duplicate_count`
- `validation_errors`
- `latency_ms.min|avg|max|samples`

Interpretation:

- Higher `missing_count` indicates packet loss or gaps.
- Higher `duplicate_count` indicates repeated deliveries.
- `parse_errors` means non-JSON datagrams were received.
- `validation_errors` means JSON did not match expected test payload schema.

## Mobile/LAN Caveats

- Some APs or mobile hotspot networks block multicast entirely.
- AP isolation can prevent device-to-device traffic on the same SSID.
- Firewalls may drop inbound UDP on the test port.
- Use `--iface-ip` when host has multiple interfaces and membership joins the wrong one.
- If multicast is unreliable, use unicast fallback with `--target-host`.

## Exit Behavior

- `0`: run completed and summary emitted.
- non-zero: startup/runtime failure (argument error, bind/join failure, socket/send error).

Packet loss itself does not force non-zero exit; it is reflected in summary metrics.
