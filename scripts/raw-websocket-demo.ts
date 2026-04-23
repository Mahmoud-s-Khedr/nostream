#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import WebSocket, { type RawData } from 'ws'

type Message = unknown[]
type JsonObject = Record<string, unknown>

interface CliOptions {
  relayUrl: string
  subId: string
  kind: number
  limit: number
  author?: string
  timeoutMs: number
  sendInvalid: boolean
  eventJsonPath?: string
}

const parseArgs = (argv: string[]): CliOptions => {
  const map = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > -1) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1))
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      map.set(arg.slice(2), argv[++i])
    } else {
      map.set(arg.slice(2), true)
    }
  }

  if (map.has('help')) {
    printHelpAndExit(0)
  }

  const toNumber = (value: string | boolean | undefined, defaultValue: number): number => {
    if (typeof value !== 'string') {
      return defaultValue
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : defaultValue
  }

  return {
    relayUrl: (map.get('relay-url') as string) ?? 'ws://localhost:8008',
    subId: (map.get('sub-id') as string) ?? 'ts-demo-sub',
    kind: toNumber(map.get('kind'), 1),
    limit: toNumber(map.get('limit'), 3),
    author: map.get('author') as string | undefined,
    timeoutMs: toNumber(map.get('timeout-ms'), 10000),
    sendInvalid: map.get('skip-invalid') ? false : true,
    eventJsonPath: map.get('event-json') as string | undefined,
  }
}

const printHelpAndExit = (code: number): never => {
  console.log(`Usage:
  node -r ts-node/register scripts/raw-websocket-demo.ts [options]

Options:
  --relay-url <ws://...>     Relay URL (default: ws://localhost:8008)
  --sub-id <id>              Subscription id for REQ/CLOSE (default: ts-demo-sub)
  --kind <number>            Filter kind for REQ (default: 1)
  --limit <number>           Filter limit for REQ (default: 3)
  --author <pubkey_hex>      Optional author pubkey filter
  --timeout-ms <number>      Timeout for awaited relay responses (default: 10000)
  --event-json <path>        Optional path to a signed event JSON to publish via EVENT
  --skip-invalid             Skip invalid REQ demonstration
  --help                     Show this help
`)
  process.exit(code)
}

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', (error) => reject(error))
  })

const sendJson = (ws: WebSocket, msg: Message): void => {
  const raw = JSON.stringify(msg)
  console.log(`--> ${raw}`)
  ws.send(raw)
}

const parseRelayMessage = (raw: RawData): Message | undefined => {
  try {
    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? (parsed as Message) : undefined
  } catch {
    return undefined
  }
}

const awaitMessage = (
  ws: WebSocket,
  predicate: (msg: Message) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Message> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`))
    }, timeoutMs)

    const onMessage = (raw: RawData) => {
      const msg = parseRelayMessage(raw)
      if (!msg) {
        return
      }
      console.log(`<-- ${JSON.stringify(msg)}`)
      if (predicate(msg)) {
        cleanup()
        resolve(msg)
      }
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }

    ws.on('message', onMessage)
    ws.on('error', onError)
  })

const run = async () => {
  const options = parseArgs(process.argv.slice(2))
  const filter: JsonObject = {
    kinds: [options.kind],
    limit: options.limit,
  }
  if (options.author) {
    filter.authors = [options.author]
  }

  const ws = await openSocket(options.relayUrl)
  console.log(`Connected to ${options.relayUrl}`)

  try {
    sendJson(ws, ['REQ', options.subId, filter])
    await awaitMessage(
      ws,
      (msg) => msg[0] === 'EOSE' && msg[1] === options.subId,
      options.timeoutMs,
      `EOSE for subscription ${options.subId}`,
    )

    if (options.sendInvalid) {
      sendJson(ws, ['REQ', 'broken'])
      await awaitMessage(
        ws,
        (msg) => msg[0] === 'NOTICE' && typeof msg[1] === 'string' && msg[1].includes('invalid:'),
        options.timeoutMs,
        'NOTICE invalid response',
      )
    }

    if (options.eventJsonPath) {
      const event = JSON.parse(readFileSync(options.eventJsonPath, 'utf8')) as JsonObject
      sendJson(ws, ['EVENT', event])
      await awaitMessage(
        ws,
        (msg) => msg[0] === 'OK' && typeof msg[1] === 'string',
        options.timeoutMs,
        'OK response for EVENT publish',
      )
    }

    sendJson(ws, ['CLOSE', options.subId])
    console.log(`Sent CLOSE for "${options.subId}"`)
  } finally {
    ws.close()
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

