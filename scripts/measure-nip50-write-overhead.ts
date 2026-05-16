import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const { Client } = pg

const args = process.argv.slice(2)
const getFlag = (name: string, fallback: string): string => {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) {
    return fallback
  }
  return args[idx + 1] ?? fallback
}

const reportDir = getFlag('out-dir', '.test-reports/nip50')
const events = Number(getFlag('events', '10000'))
const batchSize = Number(getFlag('batch', '500'))
const marker = `nip50-write-${Date.now()}-${Math.floor(Math.random() * 10000)}`
const warmupBatches = Number(getFlag('warmup-batches', '2'))

const client = new Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'nostr_ts_relay_test',
})

function percentile(values: number[], p: number): number {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function effectiveSamples(values: number[]): number[] {
  const clipped = values.slice(Math.max(0, warmupBatches))
  return clipped.length > 0 ? clipped : values
}

async function cleanup(markerPrefix: string): Promise<void> {
  await client.query('DELETE FROM event_search_metadata WHERE event_id IN (SELECT event_id FROM events WHERE event_content LIKE $1)', [
    `${markerPrefix}%`,
  ])
  await client.query('DELETE FROM events WHERE event_content LIKE $1', [`${markerPrefix}%`])
}

async function insertEventsOnly(markerPrefix: string): Promise<{ durationsMs: number[]; inserted: number }> {
  const pubkeys = Array.from({ length: 50 }, () => randomBytes(32))
  const now = Math.floor(Date.now() / 1000)
  const durations: number[] = []
  let inserted = 0

  for (let i = 0; i < events; i += batchSize) {
    const size = Math.min(batchSize, events - i)
    const values: string[] = []
    const params: unknown[] = []
    const start = performance.now()

    for (let j = 0; j < size; j++) {
      const idx = params.length
      params.push(
        randomBytes(32),
        pubkeys[(i + j) % pubkeys.length],
        now - ((i + j) % 3600),
        1,
        '[]',
        `${markerPrefix} events-only ${(i + j) % 5} apples oranges`,
        randomBytes(64),
        null,
        null,
        null,
      )
      values.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}::jsonb, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`,
      )
    }

    await client.query(
      `INSERT INTO events
        (event_id, event_pubkey, event_created_at, event_kind, event_tags, event_content, event_signature, event_deduplication, expires_at, deleted_at)
       VALUES ${values.join(',')}`,
      params,
    )

    durations.push(performance.now() - start)
    inserted += size
  }

  return { durationsMs: durations, inserted }
}

async function insertEventsWithMetadata(markerPrefix: string): Promise<{
  eventDurationsMs: number[]
  metadataDurationsMs: number[]
  inserted: number
}> {
  const pubkeys = Array.from({ length: 50 }, () => randomBytes(32))
  const now = Math.floor(Date.now() / 1000)
  const eventDurations: number[] = []
  const metadataDurations: number[] = []
  let inserted = 0

  for (let i = 0; i < events; i += batchSize) {
    const size = Math.min(batchSize, events - i)
    const eventValues: string[] = []
    const eventParams: unknown[] = []
    const eventIds: Buffer[] = []
    const startEvents = performance.now()

    for (let j = 0; j < size; j++) {
      const idx = eventParams.length
      const eventId = randomBytes(32)
      eventIds.push(eventId)
      eventParams.push(
        eventId,
        pubkeys[(i + j) % pubkeys.length],
        now - ((i + j) % 3600),
        1,
        '[]',
        `${markerPrefix} with-metadata ${(i + j) % 5} apples oranges`,
        randomBytes(64),
        null,
        null,
        null,
      )
      eventValues.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}::jsonb, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`,
      )
    }

    await client.query(
      `INSERT INTO events
        (event_id, event_pubkey, event_created_at, event_kind, event_tags, event_content, event_signature, event_deduplication, expires_at, deleted_at)
       VALUES ${eventValues.join(',')}`,
      eventParams,
    )
    eventDurations.push(performance.now() - startEvents)

    const metadataValues: string[] = []
    const metadataParams: unknown[] = []
    const startMetadata = performance.now()
    for (let j = 0; j < size; j++) {
      const idx = metadataParams.length
      metadataParams.push(
        eventIds[j],
        j % 3 === 0 ? 'en' : j % 3 === 1 ? 'es' : 'fr',
        j % 2 === 0 ? 'positive' : 'neutral',
        j % 5 === 0,
        j % 7 === 0,
      )
      metadataValues.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, 'write-bench', NOW(), 0.9, 0.9, 0.9, 0.9, 'heuristic')`)
    }

    await client.query(
      `INSERT INTO event_search_metadata
        (event_id, language, sentiment, nsfw, is_spam, classifier_version, classified_at, language_confidence, sentiment_confidence, nsfw_confidence, spam_confidence, classifier_source)
       VALUES ${metadataValues.join(',')}
       ON CONFLICT (event_id) DO UPDATE SET
         language = excluded.language,
         sentiment = excluded.sentiment,
         nsfw = excluded.nsfw,
         is_spam = excluded.is_spam,
         classifier_version = excluded.classifier_version,
         classified_at = NOW(),
         updated_at = NOW()`,
      metadataParams,
    )
    metadataDurations.push(performance.now() - startMetadata)

    inserted += size
  }

  return { eventDurationsMs: eventDurations, metadataDurationsMs: metadataDurations, inserted }
}

async function run(): Promise<void> {
  fs.mkdirSync(reportDir, { recursive: true })
  await client.connect()

  const baselineMarker = `${marker}-baseline`
  const fullMarker = `${marker}-full`

  try {
    await cleanup(baselineMarker)
    await cleanup(fullMarker)
    await client.query('ANALYZE events')
    await client.query('ANALYZE event_search_metadata')

    const baseline = await insertEventsOnly(baselineMarker)
    const full = await insertEventsWithMetadata(fullMarker)

    const baselineSamples = effectiveSamples(baseline.durationsMs)
    const fullEventSamples = effectiveSamples(full.eventDurationsMs)
    const metadataSamples = effectiveSamples(full.metadataDurationsMs)

    const baselineP95 = percentile(baselineSamples, 95)
    const baselineP99 = percentile(baselineSamples, 99)
    const fullEventP95 = percentile(fullEventSamples, 95)
    const fullEventP99 = percentile(fullEventSamples, 99)
    const metadataP95 = percentile(metadataSamples, 95)
    const metadataP99 = percentile(metadataSamples, 99)

    const baselineThroughput = baseline.inserted / (baseline.durationsMs.reduce((acc, n) => acc + n, 0) / 1000)
    const fullThroughput = full.inserted / (full.eventDurationsMs.reduce((acc, n) => acc + n, 0) / 1000)

    const report = {
      generatedAt: new Date().toISOString(),
      settings: { events, batchSize, warmupBatches },
      baseline: {
        inserted: baseline.inserted,
        throughputEventsPerSec: baselineThroughput,
        p95BatchInsertMs: baselineP95,
        p99BatchInsertMs: baselineP99,
        sampleCount: baselineSamples.length,
      },
      withMetadata: {
        inserted: full.inserted,
        eventInsertThroughputEventsPerSec: fullThroughput,
        eventInsertP95BatchMs: fullEventP95,
        eventInsertP99BatchMs: fullEventP99,
        metadataUpsertP95BatchMs: metadataP95,
        metadataUpsertP99BatchMs: metadataP99,
        eventSampleCount: fullEventSamples.length,
        metadataSampleCount: metadataSamples.length,
      },
      deltas: {
        throughputPct: ((fullThroughput - baselineThroughput) / baselineThroughput) * 100,
        p95InsertPct: ((fullEventP95 - baselineP95) / baselineP95) * 100,
        p99InsertPct: ((fullEventP99 - baselineP99) / baselineP99) * 100,
      },
    }

    const jsonPath = path.join(reportDir, 'nip50-write-overhead-report.json')
    const mdPath = path.join(reportDir, 'nip50-write-overhead-report.md')
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))

    const lines = [
      '# NIP-50 Write Overhead Benchmark',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      `Baseline throughput: ${baselineThroughput.toFixed(2)} events/sec`,
      `With metadata throughput: ${fullThroughput.toFixed(2)} events/sec`,
      `Throughput delta: ${report.deltas.throughputPct.toFixed(2)}%`,
      `Baseline p95/p99 batch insert: ${baselineP95.toFixed(2)}ms / ${baselineP99.toFixed(2)}ms`,
      `With metadata p95/p99 event insert: ${fullEventP95.toFixed(2)}ms / ${fullEventP99.toFixed(2)}ms`,
      `Metadata upsert p95/p99: ${metadataP95.toFixed(2)}ms / ${metadataP99.toFixed(2)}ms`,
      '',
      'This report is advisory; only severe regressions should become hard gates.',
      '',
    ]
    fs.writeFileSync(mdPath, lines.join('\n'))
  } finally {
    await cleanup(baselineMarker)
    await cleanup(fullMarker)
    await client.end()
  }
}

run().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
