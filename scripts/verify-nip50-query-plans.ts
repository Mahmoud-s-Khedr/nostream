import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const { Client } = pg

type ExplainPlanNode = {
  'Node Type'?: string
  'Index Name'?: string
  Plans?: ExplainPlanNode[]
}

type ExplainResult = {
  Plan: ExplainPlanNode
  'Execution Time': number
  'Planning Time': number
}

type QueryCase = {
  name: string
  sql: string
  params: unknown[]
  expectedIndexes: string[]
  expectedNodeTypes: string[]
  maxP95Ms: number
  requireIndexAssistForHardFail: boolean
}

const args = process.argv.slice(2)
const getFlag = (name: string, fallback: string): string => {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) {
    return fallback
  }
  return args[idx + 1] ?? fallback
}

const reportDir = getFlag('out-dir', '.test-reports/nip50')
const seedEvents = Number(getFlag('events', '30000'))

const client = new Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'nostr_ts_relay_test',
})

const marker = `nip50-verify-${Date.now()}-${Math.floor(Math.random() * 10000)}`

function walk(node: ExplainPlanNode, visit: (n: ExplainPlanNode) => void): void {
  visit(node)
  if (node.Plans) {
    for (const child of node.Plans) {
      walk(child, visit)
    }
  }
}

function summarize(plan: ExplainResult): { indexes: string[]; nodeTypes: string[] } {
  const indexes = new Set<string>()
  const nodeTypes = new Set<string>()
  walk(plan.Plan, (node) => {
    if (node['Index Name']) {
      indexes.add(node['Index Name'])
    }
    if (node['Node Type']) {
      nodeTypes.add(node['Node Type'])
    }
  })
  return {
    indexes: [...indexes],
    nodeTypes: [...nodeTypes],
  }
}

async function explain(sql: string, params: unknown[]): Promise<ExplainResult> {
  const { rows } = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  )
  const plan = rows[0]?.['QUERY PLAN']?.[0]
  if (!plan) {
    throw new Error('EXPLAIN returned no plan')
  }
  return plan
}

function percentile(values: number[], p: number): number {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

async function seed(): Promise<{ pubkeys: Buffer[]; domains: string[] }> {
  const pubkeys = Array.from({ length: 50 }, () => randomBytes(32))
  const domains = ['example.com', 'other.com', 'relay.dev']
  const now = Math.floor(Date.now() / 1000)

  await client.query('BEGIN')
  try {
    for (let i = 0; i < seedEvents; i += 500) {
      const size = Math.min(500, seedEvents - i)
      const values: string[] = []
      const params: unknown[] = []

      for (let j = 0; j < size; j++) {
        const idx = params.length
        const pk = pubkeys[(i + j) % pubkeys.length]
        const eventId = randomBytes(32)
        const repeated = (i + j) % 7 === 0 ? 'apples apples apples oranges' : 'apples oranges'
        const topicToken = `topic_${(i + j) % 20}`
        const content = `${marker} ${topicToken} ${repeated} orange juice language bucket ${(i + j) % 5}`
        params.push(
          eventId,
          pk,
          now - ((i + j) % 86400),
          1,
          '[]',
          content,
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
    }

    const events = await client.query<{ event_id: Buffer; event_pubkey: Buffer }>(
      `SELECT event_id, event_pubkey
       FROM events
       WHERE event_content LIKE $1
       LIMIT 5000`,
      [`${marker}%`],
    )

    for (const [idx, row] of events.rows.entries()) {
      await client.query(
        `INSERT INTO event_search_metadata
          (event_id, language, sentiment, nsfw, is_spam, classifier_version, classified_at, language_confidence, sentiment_confidence, nsfw_confidence, spam_confidence, classifier_source)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 0.99, 0.99, 0.99, 0.99, 'heuristic')
         ON CONFLICT (event_id) DO UPDATE SET
           language = excluded.language,
           sentiment = excluded.sentiment,
           nsfw = excluded.nsfw,
           is_spam = excluded.is_spam,
           classifier_version = excluded.classifier_version,
           classified_at = NOW(),
           updated_at = NOW()`,
        [
          row.event_id,
          idx % 3 === 0 ? 'en' : idx % 3 === 1 ? 'es' : 'fr',
          idx % 2 === 0 ? 'positive' : 'neutral',
          idx % 4 === 0,
          idx % 9 === 0,
          'verify-script',
        ],
      )
    }

    for (let i = 0; i < pubkeys.length; i++) {
      const domain = domains[i % domains.length]
      await client.query(
        `INSERT INTO nip05_verifications
          (pubkey, nip05, domain, is_verified, last_verified_at, last_checked_at, failure_count, created_at, updated_at)
         VALUES ($1, $2, $3, true, NOW(), NOW(), 0, NOW(), NOW())
         ON CONFLICT (pubkey) DO UPDATE SET
           domain = excluded.domain,
           nip05 = excluded.nip05,
           is_verified = true,
           updated_at = NOW(),
           last_verified_at = NOW(),
           last_checked_at = NOW()`,
        [pubkeys[i], `user${i}@${domain}`, domain],
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }

  await client.query('ANALYZE events')
  await client.query('ANALYZE event_search_metadata')
  await client.query('ANALYZE nip05_verifications')

  return { pubkeys, domains }
}

async function cleanup(): Promise<void> {
  await client.query('DELETE FROM event_search_metadata WHERE event_id IN (SELECT event_id FROM events WHERE event_content LIKE $1)', [
    `${marker}%`,
  ])
  await client.query('DELETE FROM events WHERE event_content LIKE $1', [`${marker}%`])
}

async function run(): Promise<void> {
  await client.connect()
  fs.mkdirSync(reportDir, { recursive: true })

  try {
    const { domains } = await seed()
    const searchBase = `${marker} topic_3 apples`
    const queryCases: QueryCase[] = [
      {
        name: 'REQ text-only search',
        sql: `SELECT events.event_id
              FROM events
              LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
              WHERE event_search_metadata.is_spam = false
                AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)
              ORDER BY ts_rank_cd(to_tsvector('simple', events.event_content), websearch_to_tsquery('simple', $1)) DESC, events.event_created_at DESC, events.event_id ASC
              LIMIT 50`,
        params: [searchBase],
        expectedIndexes: ['events_content_fts_idx'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 900,
        requireIndexAssistForHardFail: false,
      },
      {
        name: 'REQ search + language/sentiment/nsfw',
        sql: `SELECT events.event_id
              FROM events
              LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
              WHERE event_search_metadata.is_spam = false
                AND event_search_metadata.language = 'en'
                AND event_search_metadata.sentiment = 'positive'
                AND event_search_metadata.nsfw = false
                AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)
              ORDER BY ts_rank_cd(to_tsvector('simple', events.event_content), websearch_to_tsquery('simple', $1)) DESC, events.event_created_at DESC, events.event_id ASC
              LIMIT 50`,
        params: [searchBase],
        expectedIndexes: ['events_content_fts_idx', 'idx_event_search_metadata_language_is_spam'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 350,
        requireIndexAssistForHardFail: true,
      },
      {
        name: 'REQ search + domain',
        sql: `SELECT events.event_id
              FROM events
              LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
              LEFT JOIN nip05_verifications ON events.event_pubkey = nip05_verifications.pubkey
              WHERE event_search_metadata.is_spam = false
                AND nip05_verifications.is_verified = true
                AND nip05_verifications.domain = $2
                AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)
              ORDER BY ts_rank_cd(to_tsvector('simple', events.event_content), websearch_to_tsquery('simple', $1)) DESC, events.event_created_at DESC, events.event_id ASC
              LIMIT 50`,
        params: [searchBase, domains[0]],
        expectedIndexes: ['events_content_fts_idx'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 900,
        requireIndexAssistForHardFail: false,
      },
      {
        name: 'REQ include:spam equivalent',
        sql: `SELECT events.event_id
              FROM events
              LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
              WHERE to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)
              ORDER BY ts_rank_cd(to_tsvector('simple', events.event_content), websearch_to_tsquery('simple', $1)) DESC, events.event_created_at DESC, events.event_id ASC
              LIMIT 50`,
        params: [searchBase],
        expectedIndexes: ['events_content_fts_idx'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 1000,
        requireIndexAssistForHardFail: false,
      },
      {
        name: 'COUNT with search + extensions',
        sql: `SELECT COUNT(DISTINCT events.event_id) AS count
              FROM events
              LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
              WHERE event_search_metadata.is_spam = false
                AND event_search_metadata.language = 'en'
                AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)`,
        params: [searchBase],
        expectedIndexes: ['events_content_fts_idx'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 450,
        requireIndexAssistForHardFail: true,
      },
      {
        name: 'REQ multi-filter union equivalent',
        sql: `SELECT event_id FROM (
                (SELECT events.event_id
                 FROM events
                 LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
                 WHERE event_search_metadata.is_spam = false
                   AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $1)
                 LIMIT 25)
                UNION
                (SELECT events.event_id
                 FROM events
                 LEFT JOIN event_search_metadata ON events.event_id = event_search_metadata.event_id
                 WHERE event_search_metadata.is_spam = false
                   AND to_tsvector('simple', events.event_content) @@ websearch_to_tsquery('simple', $2)
                 LIMIT 25)
              ) u`,
        params: [`${marker} topic_3 apples`, `${marker} topic_7 oranges`],
        expectedIndexes: ['events_content_fts_idx'],
        expectedNodeTypes: ['Bitmap Index Scan', 'Index Scan'],
        maxP95Ms: 200,
        requireIndexAssistForHardFail: true,
      },
    ]

    const results: Array<Record<string, unknown>> = []
    const hardFailures: string[] = []
    const advisoryWarnings: string[] = []

    for (const queryCase of queryCases) {
      const execTimes: number[] = []
      let summary: { indexes: string[]; nodeTypes: string[] } = { indexes: [], nodeTypes: [] }
      for (let i = 0; i < 3; i++) {
        const plan = await explain(queryCase.sql, queryCase.params)
        execTimes.push(plan['Execution Time'])
        summary = summarize(plan)
      }

      const missingIndexes = queryCase.expectedIndexes.filter((name) => !summary.indexes.includes(name))
      const hasExpectedNodeType = queryCase.expectedNodeTypes.some((name) => summary.nodeTypes.includes(name))
      const p95Ms = percentile(execTimes, 95)
      const hasAnyIndexAssist = summary.nodeTypes.includes('Bitmap Index Scan') || summary.nodeTypes.includes('Index Scan')
      const hasSeqScan = summary.nodeTypes.includes('Seq Scan')

      if (queryCase.requireIndexAssistForHardFail && !hasAnyIndexAssist) {
        hardFailures.push(`${queryCase.name}: no index-assisted node was observed`)
      }
      if (p95Ms > queryCase.maxP95Ms) {
        hardFailures.push(
          `${queryCase.name}: p95 ${p95Ms.toFixed(2)}ms exceeds threshold ${queryCase.maxP95Ms.toFixed(2)}ms`,
        )
      }
      if (hasSeqScan && !hasAnyIndexAssist && p95Ms > queryCase.maxP95Ms * 0.75) {
        hardFailures.push(`${queryCase.name}: pathological scan pattern (seq scan without index assist under high latency)`)
      }
      if (missingIndexes.length > 0) {
        advisoryWarnings.push(`${queryCase.name}: expected index names not observed: ${missingIndexes.join(', ')}`)
      }
      if (!hasExpectedNodeType) {
        advisoryWarnings.push(`${queryCase.name}: expected index-scan node type not observed`)
      }

      results.push({
        name: queryCase.name,
        expectedIndexes: queryCase.expectedIndexes,
        observedIndexes: summary.indexes,
        observedNodeTypes: summary.nodeTypes,
        p50Ms: percentile(execTimes, 50),
        p95Ms,
        hardThresholdP95Ms: queryCase.maxP95Ms,
        runs: execTimes,
      })
    }

    const output = {
      marker,
      generatedAt: new Date().toISOString(),
      hardFailures,
      advisoryWarnings,
      results,
    }

    const jsonPath = path.join(reportDir, 'nip50-query-plan-report.json')
    const mdPath = path.join(reportDir, 'nip50-query-plan-report.md')
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2))

    const lines = [
      '# NIP-50 Query Plan Verification',
      '',
      `Generated: ${output.generatedAt}`,
      '',
      `Hard failures: ${hardFailures.length}`,
      `Advisory warnings: ${advisoryWarnings.length}`,
      '',
    ]
    if (hardFailures.length) {
      lines.push('## Hard Failures')
      for (const failure of hardFailures) {
        lines.push(`- ${failure}`)
      }
      lines.push('')
    }
    if (advisoryWarnings.length) {
      lines.push('## Advisory Warnings')
      for (const warning of advisoryWarnings) {
        lines.push(`- ${warning}`)
      }
      lines.push('')
    }
    lines.push('## Results')
    for (const result of results) {
      lines.push(`- ${result.name as string}: p50=${(result.p50Ms as number).toFixed(2)}ms, p95=${(result.p95Ms as number).toFixed(2)}ms, indexes=${(result.observedIndexes as string[]).join(', ') || 'none'}`)
    }
    lines.push('')
    fs.writeFileSync(mdPath, lines.join('\n'))

    if (hardFailures.length > 0) {
      throw new Error(`NIP-50 query plan verification failed (${hardFailures.length} hard failures)`)
    }
  } finally {
    try {
      await cleanup()
    } catch {
      // best-effort cleanup
    }
    await client.end()
  }
}

run().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
