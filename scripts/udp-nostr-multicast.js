#!/usr/bin/env node

const crypto = require("node:crypto");
const dgram = require("node:dgram");

const MULTICAST_GROUP = "239.255.0.1";
const PORT = 33333;
const BIND_ADDR = "0.0.0.0";
const TIMEOUT_MS = 3000;

const marker = `nostr-udp-selftest-${Date.now()}-${crypto.randomUUID()}`;
const now = Math.floor(Date.now() / 1000);

const dummyEvent = {
  id: crypto.randomBytes(32).toString("hex"),
  pubkey: crypto.randomBytes(32).toString("hex"),
  created_at: now,
  kind: 1,
  tags: [["client", "udp-multicast-selftest"]],
  content: "dummy nostr event over udp multicast",
  sig: crypto.randomBytes(64).toString("hex"),
};

const payload = {
  marker,
  sent_at: new Date().toISOString(),
  event: dummyEvent,
};

const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
let finalized = false;
let timeoutId;

function isHexOfLength(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value)
  );
}

function isValidNostrEvent(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  if (!isHexOfLength(event.id, 64)) return false;
  if (!isHexOfLength(event.pubkey, 64)) return false;
  if (!Number.isInteger(event.created_at)) return false;
  if (!Number.isInteger(event.kind)) return false;
  if (!Array.isArray(event.tags)) return false;
  if (typeof event.content !== "string") return false;
  if (!isHexOfLength(event.sig, 128)) return false;

  return true;
}

function finalize(code, message) {
  if (finalized) return;
  finalized = true;

  clearTimeout(timeoutId);
  if (code === 0) {
    console.log(message);
  } else {
    console.error(message);
  }

  try {
    socket.close(() => process.exit(code));
  } catch (_) {
    process.exit(code);
  }
}

socket.on("error", (error) => {
  finalize(1, `Socket error: ${error.message}`);
});

socket.on("message", (msg, rinfo) => {
  const text = msg.toString("utf8");
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return;
  }

  if (!parsed || parsed.marker !== marker) {
    return;
  }

  if (!isValidNostrEvent(parsed.event)) {
    finalize(1, "Received self-broadcast but payload failed Nostr event validation.");
    return;
  }

  console.log("Received and parsed self-broadcast successfully.");
  console.log(
    JSON.stringify(
      {
        from: `${rinfo.address}:${rinfo.port}`,
        marker: parsed.marker,
        event: {
          id: parsed.event.id,
          pubkey: parsed.event.pubkey,
          kind: parsed.event.kind,
          created_at: parsed.event.created_at,
        },
      },
      null,
      2
    )
  );

  finalize(0, "UDP multicast self-receive test passed.");
});

timeoutId = setTimeout(() => {
  finalize(1, `Timed out after ${TIMEOUT_MS}ms waiting for self-broadcast.`);
}, TIMEOUT_MS);

socket.bind(PORT, BIND_ADDR, () => {
  try {
    socket.setMulticastLoopback(true);
    socket.setMulticastTTL(1);
    socket.addMembership(MULTICAST_GROUP);
  } catch (error) {
    finalize(1, `Multicast setup failed: ${error.message}`);
    return;
  }

  const buffer = Buffer.from(JSON.stringify(payload), "utf8");

  console.log(
    `Bound to ${BIND_ADDR}:${PORT}, joined ${MULTICAST_GROUP}, sending dummy Nostr event...`
  );

  socket.send(buffer, PORT, MULTICAST_GROUP, (error) => {
    if (error) {
      finalize(1, `Send failed: ${error.message}`);
      return;
    }
    console.log("Broadcast sent. Waiting to receive looped-back packet...");
  });
});
