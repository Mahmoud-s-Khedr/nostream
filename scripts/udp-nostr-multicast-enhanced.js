#!/usr/bin/env node

const crypto = require("node:crypto");
const dgram = require("node:dgram");

const DEFAULTS = {
  mode: "both",
  group: "239.255.0.1",
  port: 33333,
  bind: "0.0.0.0",
  ifaceIp: undefined,
  targetHost: undefined,
  targetPort: undefined,
  durationMs: 30000,
  intervalMs: 1000,
  ttl: 1,
  loopback: true,
};

function parseBoolean(value, flagName) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid value for ${flagName}: ${value}. Use true/false.`);
}

function parseInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${flagName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [key, rawValue] = arg.slice(2).split("=");
    const value = rawValue ?? "";

    switch (key) {
      case "mode":
        options.mode = value;
        break;
      case "group":
        options.group = value;
        break;
      case "port":
        options.port = parseInteger(value, "--port");
        break;
      case "bind":
        options.bind = value;
        break;
      case "iface-ip":
        options.ifaceIp = value || undefined;
        break;
      case "target-host":
        options.targetHost = value || undefined;
        break;
      case "target-port":
        options.targetPort = parseInteger(value, "--target-port");
        break;
      case "duration-ms":
        options.durationMs = parseInteger(value, "--duration-ms");
        break;
      case "interval-ms":
        options.intervalMs = parseInteger(value, "--interval-ms");
        break;
      case "ttl":
        options.ttl = parseInteger(value, "--ttl");
        break;
      case "loopback":
        options.loopback = parseBoolean(value, "--loopback");
        break;
      case "help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }

  if (!["sender", "receiver", "both"].includes(options.mode)) {
    throw new Error(`Invalid --mode: ${options.mode}. Use sender|receiver|both.`);
  }

  if (options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid --port: ${options.port}.`);
  }

  if (options.targetPort !== undefined && (options.targetPort < 1 || options.targetPort > 65535)) {
    throw new Error(`Invalid --target-port: ${options.targetPort}.`);
  }

  if (options.targetHost && options.targetPort === undefined) {
    options.targetPort = options.port;
  }

  if (!options.targetHost && options.targetPort !== undefined) {
    throw new Error("--target-port requires --target-host.");
  }

  if (options.durationMs <= 0) {
    throw new Error("--duration-ms must be > 0.");
  }

  if (options.intervalMs <= 0) {
    throw new Error("--interval-ms must be > 0.");
  }

  if (options.ttl < 0 || options.ttl > 255) {
    throw new Error("--ttl must be between 0 and 255.");
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/udp-nostr-multicast-enhanced.js [flags]

Flags:
  --mode=sender|receiver|both        Role to run (default: both)
  --group=<multicast-ip>             Multicast group (default: 239.255.0.1)
  --port=<udp-port>                  UDP port for bind/send (default: 33333)
  --bind=<bind-ip>                   Bind address for receiver/both (default: 0.0.0.0)
  --iface-ip=<interface-ip>          Optional interface for addMembership
  --target-host=<host>               Optional unicast target host
  --target-port=<port>               Optional unicast target port (defaults to --port)
  --duration-ms=<ms>                 Total test duration (default: 30000)
  --interval-ms=<ms>                 Sender packet interval (default: 1000)
  --ttl=<0-255>                      Multicast TTL (default: 1)
  --loopback=true|false              Multicast loopback (default: true)
  --help                             Show this help
`);
}

function isHexOfLength(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value)
  );
}

function buildDummyEvent() {
  return {
    id: crypto.randomBytes(32).toString("hex"),
    pubkey: crypto.randomBytes(32).toString("hex"),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [["client", "udp-multicast-enhanced"]],
    content: "dummy nostr event over udp multicast/unicast",
    sig: crypto.randomBytes(64).toString("hex"),
  };
}

function isValidNostrEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (!isHexOfLength(event.id, 64)) return false;
  if (!isHexOfLength(event.pubkey, 64)) return false;
  if (!Number.isInteger(event.created_at)) return false;
  if (!Number.isInteger(event.kind)) return false;
  if (!Array.isArray(event.tags)) return false;
  if (typeof event.content !== "string") return false;
  if (!isHexOfLength(event.sig, 128)) return false;
  return true;
}

function makeSenderMetrics() {
  return {
    received_count: 0,
    unique_count: 0,
    min_seq: null,
    max_seq: null,
    missing_count: 0,
    duplicate_count: 0,
    validation_errors: 0,
    latency_ms: {
      min: null,
      max: null,
      avg: null,
      samples: 0,
      sum: 0,
    },
    seen_seq: new Set(),
  };
}

function updateMissing(metrics) {
  if (metrics.min_seq === null || metrics.max_seq === null) {
    metrics.missing_count = 0;
    return;
  }
  const expected = metrics.max_seq - metrics.min_seq + 1;
  metrics.missing_count = Math.max(0, expected - metrics.unique_count);
}

function finalizeSummary(summary, exitCode) {
  const out = {
    script: "udp-nostr-multicast-enhanced",
    started_at: summary.startedAt,
    ended_at: new Date().toISOString(),
    exit_code: exitCode,
    config: summary.config,
    counters: summary.counters,
    senders: {},
  };

  for (const [senderId, metrics] of Object.entries(summary.senders)) {
    out.senders[senderId] = {
      received_count: metrics.received_count,
      min_seq: metrics.min_seq,
      max_seq: metrics.max_seq,
      missing_count: metrics.missing_count,
      duplicate_count: metrics.duplicate_count,
      validation_errors: metrics.validation_errors,
      latency_ms: {
        min: metrics.latency_ms.min,
        max: metrics.latency_ms.max,
        avg: metrics.latency_ms.avg,
        samples: metrics.latency_ms.samples,
      },
    };
  }

  console.log("FINAL_SUMMARY_JSON_START");
  console.log(JSON.stringify(out, null, 2));
  console.log("FINAL_SUMMARY_JSON_END");
}

function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    printHelp();
    process.exit(1);
  }

  const senderId = `sender-${crypto.randomUUID()}`;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const wantsSender = options.mode === "sender" || options.mode === "both";
  const wantsReceiver = options.mode === "receiver" || options.mode === "both";

  let intervalId;
  let stopTimerId;
  let finished = false;
  let seq = 0;

  const summary = {
    startedAt: new Date().toISOString(),
    config: {
      mode: options.mode,
      group: options.group,
      port: options.port,
      bind: options.bind,
      iface_ip: options.ifaceIp || null,
      target_host: options.targetHost || null,
      target_port: options.targetPort || null,
      duration_ms: options.durationMs,
      interval_ms: options.intervalMs,
      ttl: options.ttl,
      loopback: options.loopback,
      sender_id: senderId,
    },
    counters: {
      packets_sent_total: 0,
      packets_received_total: 0,
      send_errors: 0,
      parse_errors: 0,
      validation_errors: 0,
    },
    senders: {},
  };

  function ensureSenderMetrics(id) {
    if (!summary.senders[id]) {
      summary.senders[id] = makeSenderMetrics();
    }
    return summary.senders[id];
  }

  function failAndExit(message) {
    if (finished) return;
    finished = true;
    clearInterval(intervalId);
    clearTimeout(stopTimerId);
    console.error(message);
    finalizeSummary(summary, 1);
    try {
      socket.close(() => process.exit(1));
    } catch (_) {
      process.exit(1);
    }
  }

  function finishOk() {
    if (finished) return;
    finished = true;
    clearInterval(intervalId);
    clearTimeout(stopTimerId);
    finalizeSummary(summary, 0);
    try {
      socket.close(() => process.exit(0));
    } catch (_) {
      process.exit(0);
    }
  }

  function validateEnvelope(packet) {
    if (!packet || typeof packet !== "object") return false;
    if (typeof packet.sender_id !== "string" || packet.sender_id.length === 0) return false;
    if (!Number.isInteger(packet.seq)) return false;
    if (typeof packet.sent_at !== "string") return false;
    if (!["multicast", "unicast"].includes(packet.transport)) return false;
    if (!isValidNostrEvent(packet.event)) return false;
    return true;
  }

  function handleMessage(msg) {
    const text = msg.toString("utf8");
    let packet;

    try {
      packet = JSON.parse(text);
    } catch (_) {
      summary.counters.parse_errors += 1;
      return;
    }

    if (!validateEnvelope(packet)) {
      summary.counters.validation_errors += 1;
      if (packet && typeof packet.sender_id === "string") {
        const m = ensureSenderMetrics(packet.sender_id);
        m.validation_errors += 1;
      }
      return;
    }

    summary.counters.packets_received_total += 1;

    const metrics = ensureSenderMetrics(packet.sender_id);
    metrics.received_count += 1;

    if (metrics.min_seq === null || packet.seq < metrics.min_seq) metrics.min_seq = packet.seq;
    if (metrics.max_seq === null || packet.seq > metrics.max_seq) metrics.max_seq = packet.seq;

    if (metrics.seen_seq.has(packet.seq)) {
      metrics.duplicate_count += 1;
    } else {
      metrics.seen_seq.add(packet.seq);
      metrics.unique_count += 1;
    }

    updateMissing(metrics);

    const sentAtMs = Date.parse(packet.sent_at);
    if (Number.isFinite(sentAtMs)) {
      const latency = Date.now() - sentAtMs;
      if (Number.isFinite(latency) && latency >= 0) {
        const lat = metrics.latency_ms;
        lat.samples += 1;
        lat.sum += latency;
        lat.min = lat.min === null ? latency : Math.min(lat.min, latency);
        lat.max = lat.max === null ? latency : Math.max(lat.max, latency);
        lat.avg = Math.round(lat.sum / lat.samples);
      }
    }
  }

  function sendOnePacket(transport, host, port) {
    const packet = {
      sender_id: senderId,
      seq,
      sent_at: new Date().toISOString(),
      transport,
      event: buildDummyEvent(),
    };

    const buffer = Buffer.from(JSON.stringify(packet), "utf8");

    socket.send(buffer, port, host, (error) => {
      if (error) {
        summary.counters.send_errors += 1;
        failAndExit(`Send error (${transport} ${host}:${port}): ${error.message}`);
        return;
      }
      summary.counters.packets_sent_total += 1;
    });
  }

  function startSenderLoop() {
    if (!wantsSender) return;

    const tick = () => {
      seq += 1;
      sendOnePacket("multicast", options.group, options.port);
      if (options.targetHost) {
        sendOnePacket("unicast", options.targetHost, options.targetPort);
      }
    };

    tick();
    intervalId = setInterval(tick, options.intervalMs);
  }

  function startTimers() {
    stopTimerId = setTimeout(() => {
      finishOk();
    }, options.durationMs);
  }

  socket.on("error", (error) => {
    failAndExit(`Socket error: ${error.message}`);
  });

  socket.on("message", (msg) => {
    if (!wantsReceiver) return;
    handleMessage(msg);
  });

  console.log("Starting enhanced UDP Nostr test with config:");
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        group: options.group,
        port: options.port,
        bind: options.bind,
        iface_ip: options.ifaceIp || null,
        target_host: options.targetHost || null,
        target_port: options.targetPort || null,
        duration_ms: options.durationMs,
        interval_ms: options.intervalMs,
        ttl: options.ttl,
        loopback: options.loopback,
        sender_id: senderId,
      },
      null,
      2
    )
  );

  if (wantsReceiver) {
    socket.bind(options.port, options.bind, () => {
      try {
        socket.setMulticastTTL(options.ttl);
        socket.setMulticastLoopback(options.loopback);
        if (options.ifaceIp) {
          socket.addMembership(options.group, options.ifaceIp);
        } else {
          socket.addMembership(options.group);
        }
      } catch (error) {
        failAndExit(`Multicast setup failed: ${error.message}`);
        return;
      }

      startSenderLoop();
      startTimers();
    });
  } else {
    socket.bind(0, options.bind, () => {
      try {
        socket.setMulticastTTL(options.ttl);
        socket.setMulticastLoopback(options.loopback);
      } catch (error) {
        failAndExit(`Socket configuration failed: ${error.message}`);
        return;
      }

      startSenderLoop();
      startTimers();
    });
  }
}

main();
