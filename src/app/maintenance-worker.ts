import {
  DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS,
  Nip05VerificationOutcome,
  verifyNip05Identifier,
} from '../utils/nip05'
import { IMaintenanceService, IPaymentsService } from '../@types/services'
import { mergeDeepLeft, path, pipe } from 'ramda'
import { IRunnable } from '../@types/base'

import { createLogger } from '../factories/logger-factory'
import { delayMs } from '../utils/misc'
import { INip05VerificationRepository, ISearchMetadataRepository } from '../@types/repositories'
import { InvoiceStatus } from '../@types/invoice'
import { isExpiredInvoice } from '../utils/invoice'
import { Nip05Verification } from '../@types/nip05'
import { Settings } from '../@types/settings'
import {
  classifySearchMetadata,
  classifySearchMetadataTieredBatch,
  createSearchClassificationCacheKey,
  getSearchInferenceProvider,
} from '../utils/search-classifier'
import os from 'os'

const UPDATE_INVOICE_INTERVAL = 60000
const NIP05_REVERIFICATION_BATCH_SIZE = 50
const SEARCH_CLASSIFICATION_BATCH_SIZE = 200
const CLEAR_OLD_EVENTS_TIMEOUT_MS = 5000
const SEARCH_CLASSIFICATION_MAX_RETRIES = 3
const DEFAULT_CLASSIFICATION_CACHE_TTL_MS = 300000
const DEFAULT_CLASSIFICATION_CACHE_MAX_ENTRIES = 5000
const DEFAULT_CLASSIFICATION_RATE_PER_SECOND = 200
const DEFAULT_CLASSIFICATION_MAX_LAG_SECONDS = 45
const DEFAULT_SEARCHABLE_KINDS = [1]

const logger = createLogger('maintenance-worker')

const isNotFoundError = (error: unknown): boolean =>
  (error as any)?.response?.status === 404

/**
 * Merge a re-verification outcome onto an existing verification row.
 *
 * Definitive outcomes (`verified`, `mismatch`, `invalid`) update `isVerified`
 * and `lastVerifiedAt`. Transient `error` outcomes only bump `failureCount` /
 * `lastCheckedAt` so a previously-verified author keeps their grace period
 * until `verifyExpiration` elapses. This prevents a single network blip from
 * immediately blocking publishing.
 */
export function applyReverificationOutcome(
  existing: Nip05Verification,
  outcome: Nip05VerificationOutcome,
): Nip05Verification {
  const now = new Date()
  const base: Nip05Verification = {
    ...existing,
    lastCheckedAt: now,
    updatedAt: now,
  }

  switch (outcome.status) {
    case 'verified':
      return {
        ...base,
        isVerified: true,
        lastVerifiedAt: now,
        failureCount: 0,
      }
    case 'mismatch':
    case 'invalid':
      return {
        ...base,
        isVerified: false,
        lastVerifiedAt: null,
        failureCount: existing.failureCount + 1,
      }
    case 'error':
    default:
      return {
        ...base,
        failureCount: existing.failureCount + 1,
      }
  }
}

export class MaintenanceWorker implements IRunnable {
  private interval: NodeJS.Timeout | undefined
  private isRunning = false
  private classificationWindowStartMs = 0
  private classifiedInWindow = 0
  private readonly classificationContentCache = new Map<string, { metadata: ReturnType<typeof classifySearchMetadata>; expiresAt: number }>()
  private readonly classificationSignatureCache = new Map<
    string,
    { metadata: ReturnType<typeof classifySearchMetadata>; expiresAt: number }
  >()

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly paymentsService: IPaymentsService,
    private readonly maintenanceService: IMaintenanceService,
    private readonly settings: () => Settings,
    private readonly nip05VerificationRepository: INip05VerificationRepository,
    private readonly searchMetadataRepository: ISearchMetadataRepository,
  ) {
    this.process
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  private async clearOldEventsSafely(): Promise<void> {
    try {
      await Promise.race([
        this.maintenanceService.clearOldEvents(),
        delayMs(CLEAR_OLD_EVENTS_TIMEOUT_MS).then(() => {
          throw new Error(`clearOldEvents timed out after ${CLEAR_OLD_EVENTS_TIMEOUT_MS}ms`)
        }),
      ])
    } catch (error) {
      logger('unable to clear old events: %o', error)
    }
  }

  public run(): void {
    this.interval = setInterval(async () => {
      if (this.isRunning) {
        logger('skipping scheduled maintenance run because previous run is still in progress')
        return
      }

      this.isRunning = true
      try {
        await this.onSchedule()
      } catch (error) {
        this.onError(error as Error)
      } finally {
        this.isRunning = false
      }
    }, UPDATE_INVOICE_INTERVAL)
  }

  private async onSchedule(): Promise<void> {
    const currentSettings = this.settings()
    const clearOldEventsPromise = this.clearOldEventsSafely()

    await this.processNip05Reverifications(currentSettings)
    await this.processSearchClassification()

    if (!path(['payments', 'enabled'], currentSettings)) {
      await clearOldEventsPromise
      return
    }

    const invoices = await this.paymentsService.getPendingInvoices()
    logger('found %d pending invoices', invoices.length)
    const delay = () => delayMs(100 + Math.floor(Math.random() * 10))

    let successful = 0

    for (const invoice of invoices) {
      try {
        logger('getting invoice %s from payment processor: %o', invoice.id, invoice)
        const updatedInvoice = await this.paymentsService.getInvoiceFromPaymentsProcessor(invoice)
        await delay()
        logger('updating invoice status %s: %o', updatedInvoice.id, updatedInvoice)

        if (typeof updatedInvoice.id !== 'string' || typeof updatedInvoice.status !== 'string') {
          continue
        }
        const { id, status } = updatedInvoice

        await this.paymentsService.updateInvoiceStatus({ id, status })

        if (
          invoice.status !== updatedInvoice.status &&
          updatedInvoice.status == InvoiceStatus.COMPLETED &&
          updatedInvoice.confirmedAt
        ) {
          logger('confirming invoice %s & notifying %s', invoice.id, invoice.pubkey)

          const update = pipe(
            mergeDeepLeft(updatedInvoice),
            mergeDeepLeft({ amountPaid: invoice.amountRequested }),
          )(invoice)

          await Promise.all([
            this.paymentsService.confirmInvoice(update),
            this.paymentsService.sendInvoiceUpdateNotification(update),
          ])

          await delay()
        }
        successful++
      } catch (error) {
        if (isNotFoundError(error) && isExpiredInvoice(invoice)) {
          logger('marking expired invoice %s after payment processor returned 404', invoice.id)
          await this.paymentsService.updateInvoiceStatus({
            id: invoice.id,
            status: InvoiceStatus.EXPIRED,
          })
          successful++
          continue
        }

        logger.error('Unable to update invoice from payment processor. Reason:', error)
      }

      logger('updated %d of %d invoices successfully', successful, invoices.length)
    }

    await clearOldEventsPromise
  }

  private async processNip05Reverifications(currentSettings: Settings): Promise<void> {
    const nip05Settings = currentSettings.nip05
    if (!nip05Settings || nip05Settings.mode === 'disabled') {
      return
    }

    try {
      const updateFrequency = nip05Settings.verifyUpdateFrequency ?? DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS
      const maxFailures = nip05Settings.maxConsecutiveFailures ?? DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES

      const pendingVerifications = await this.nip05VerificationRepository.findPendingVerifications(
        updateFrequency,
        maxFailures,
        NIP05_REVERIFICATION_BATCH_SIZE,
      )

      if (!pendingVerifications.length) {
        return
      }

      logger('found %d NIP-05 verifications to re-check', pendingVerifications.length)

      for (const verification of pendingVerifications) {
        try {
          const outcome = await verifyNip05Identifier(verification.nip05, verification.pubkey)
          const updated = applyReverificationOutcome(verification, outcome)
          await this.nip05VerificationRepository.upsert(updated)
          await delayMs(200 + Math.floor(Math.random() * 100))
        } catch (error) {
          logger('failed to re-verify NIP-05 for %s: %o', verification.pubkey, error)
        }
      }
    } catch (error) {
      logger('NIP-05 re-verification batch failed: %o', error)
    }
  }

  private async processSearchClassification(): Promise<void> {
    try {
      const currentSettings = this.settings()
      const classificationSettings = currentSettings.nip50?.classification
      if (classificationSettings?.enabled === false) {
        return
      }

      const batchSize = classificationSettings?.queue?.batchSize ?? SEARCH_CLASSIFICATION_BATCH_SIZE
      const maxPerSecond = classificationSettings?.queue?.maxPerSecond ?? DEFAULT_CLASSIFICATION_RATE_PER_SECOND
      const maxLagSeconds = classificationSettings?.queue?.maxLagSeconds ?? DEFAULT_CLASSIFICATION_MAX_LAG_SECONDS
      const searchableKinds = classificationSettings?.queue?.searchableKinds ?? DEFAULT_SEARCHABLE_KINDS
      const maxWorkerCpuPercent = classificationSettings?.slo?.maxWorkerCpuPercent ?? 85

      const unclassified = await this.searchMetadataRepository.findUnclassifiedEvents(batchSize)
      if (!unclassified.length) {
        return
      }

      const prioritized = [...unclassified].sort((a, b) => {
        const aPriority = searchableKinds.includes(a.kind) ? 0 : 1
        const bPriority = searchableKinds.includes(b.kind) ? 0 : 1
        if (aPriority !== bPriority) {
          return aPriority - bPriority
        }
        return b.kind - a.kind
      })

      const queueLagSeconds = prioritized.length / Math.max(1, maxPerSecond)
      const backpressureFallback = queueLagSeconds > maxLagSeconds
      const loadAverage = os.loadavg()[0] / Math.max(1, os.cpus().length)
      const cpuPressureFallback = loadAverage * 100 > maxWorkerCpuPercent
      const modelSettings = classificationSettings?.model
      const modelEnabled = (modelSettings?.enabled ?? false) && !backpressureFallback && !cpuPressureFallback
      const inferencer = modelEnabled ? await getSearchInferenceProvider() : null
      const effectiveClassificationSettings = {
        ...classificationSettings,
        model: {
          ...modelSettings,
          enabled: modelEnabled && inferencer !== null,
        },
      }

      if (modelEnabled && !inferencer) {
        logger('onnx model stage requested but unavailable; falling back to heuristic-only classification')
      }

      if (backpressureFallback) {
        logger(
          'classification backlog is high (lag=%.2fs > %ds); temporarily using heuristic-only path',
          queueLagSeconds,
          maxLagSeconds,
        )
      }

      if (cpuPressureFallback) {
        logger(
          'worker cpu pressure is high (normalized_load=%.2f, threshold=%d%%); temporarily using heuristic-only path',
          loadAverage * 100,
          maxWorkerCpuPercent,
        )
      }

      logger('found %d events pending search classification', prioritized.length)

      const ttlMs = classificationSettings?.cache?.ttlMs ?? DEFAULT_CLASSIFICATION_CACHE_TTL_MS
      const maxEntries = classificationSettings?.cache?.maxEntries ?? DEFAULT_CLASSIFICATION_CACHE_MAX_ENTRIES
      const now = Date.now()

      const cachedMetadata: ReturnType<typeof classifySearchMetadata>[] = []
      const toClassify: Array<{ eventId: string; content: string; pubkey: string }> = []
      for (const event of prioritized) {
        const signatureKey = createSearchClassificationCacheKey(event.pubkey, event.content)
        const cachedBySignature = this.getCachedClassification(this.classificationSignatureCache, signatureKey, now)
        if (cachedBySignature) {
          cachedMetadata.push({ ...cachedBySignature, eventId: event.eventId, classifiedAt: new Date() })
          continue
        }

        const contentKey = signatureKey.split(':')[1]
        const cachedByContent = this.getCachedClassification(this.classificationContentCache, contentKey, now)
        if (cachedByContent) {
          this.setCachedClassification(this.classificationSignatureCache, signatureKey, cachedByContent, now + ttlMs, maxEntries)
          cachedMetadata.push({ ...cachedByContent, eventId: event.eventId, classifiedAt: new Date() })
          continue
        }

        toClassify.push({ eventId: event.eventId, content: event.content, pubkey: event.pubkey })
      }

      await this.consumeClassificationRateBudget(Math.max(1, maxPerSecond), toClassify.length)

      const tiered = await classifySearchMetadataTieredBatch(
        toClassify.map((entry) => ({ eventId: entry.eventId, content: entry.content })),
        effectiveClassificationSettings,
        inferencer,
      )

      const metadata = [
        ...cachedMetadata,
        ...tiered.map((entry) => entry.metadata),
      ]

      let shadowDiffCount = 0
      tiered.forEach((entry, index) => {
        const item = toClassify[index]
        if (!item) {
          return
        }
        const key = createSearchClassificationCacheKey(item.pubkey, item.content)
        const contentKey = key.split(':')[1]
        this.setCachedClassification(this.classificationSignatureCache, key, entry.metadata, now + ttlMs, maxEntries)
        this.setCachedClassification(this.classificationContentCache, contentKey, entry.metadata, now + ttlMs, maxEntries)

        if (entry.shadow) {
          if (
            entry.shadow.language !== entry.metadata.language ||
            entry.shadow.sentiment !== entry.metadata.sentiment ||
            entry.shadow.nsfw !== entry.metadata.nsfw ||
            entry.shadow.isSpam !== entry.metadata.isSpam
          ) {
            shadowDiffCount++
          }
        }
      })

      const stats = metadata.reduce(
        (acc, item) => {
          if (item.language) {
            acc.languageClassified++
          }
          if (item.sentiment === 'positive') {
            acc.sentimentPositive++
          } else if (item.sentiment === 'negative') {
            acc.sentimentNegative++
          } else {
            acc.sentimentNeutral++
          }
          if (item.nsfw) {
            acc.nsfwTrue++
          }
          if (item.isSpam) {
            acc.spamTrue++
          }
          return acc
        },
        {
          languageClassified: 0,
          sentimentPositive: 0,
          sentimentNegative: 0,
          sentimentNeutral: 0,
          nsfwTrue: 0,
          spamTrue: 0,
        },
      )
      await this.upsertSearchMetadataWithRetry(metadata)
      logger(
        'search classification summary: total=%d language=%d sentiment={+:%d,-:%d,0:%d} nsfw=%d spam=%d shadow_diffs=%d',
        metadata.length,
        stats.languageClassified,
        stats.sentimentPositive,
        stats.sentimentNegative,
        stats.sentimentNeutral,
        stats.nsfwTrue,
        stats.spamTrue,
        shadowDiffCount,
      )
    } catch (error) {
      logger('search classification batch failed: %o', error)
    }
  }

  private getCachedClassification(
    cache: Map<string, { metadata: ReturnType<typeof classifySearchMetadata>; expiresAt: number }>,
    key: string,
    now: number,
  ): ReturnType<typeof classifySearchMetadata> | undefined {
    const hit = cache.get(key)
    if (!hit) {
      return undefined
    }
    if (hit.expiresAt <= now) {
      cache.delete(key)
      return undefined
    }
    return hit.metadata
  }

  private setCachedClassification(
    cache: Map<string, { metadata: ReturnType<typeof classifySearchMetadata>; expiresAt: number }>,
    key: string,
    metadata: ReturnType<typeof classifySearchMetadata>,
    expiresAt: number,
    maxEntries: number,
  ): void {
    cache.set(key, { metadata, expiresAt })
    if (cache.size <= maxEntries) {
      return
    }
    const first = cache.keys().next()
    if (!first.done) {
      cache.delete(first.value)
    }
  }

  private async consumeClassificationRateBudget(maxPerSecond: number, items: number): Promise<void> {
    if (items <= 0) {
      return
    }

    const now = Date.now()
    const windowAge = now - this.classificationWindowStartMs
    if (this.classificationWindowStartMs === 0 || windowAge >= 1000) {
      this.classificationWindowStartMs = now
      this.classifiedInWindow = 0
    }

    const remaining = maxPerSecond - this.classifiedInWindow
    if (remaining >= items) {
      this.classifiedInWindow += items
      return
    }

    const waitMs = 1000 - (now - this.classificationWindowStartMs)
    if (waitMs > 0) {
      await delayMs(waitMs)
    }
    this.classificationWindowStartMs = Date.now()
    this.classifiedInWindow = Math.min(items, maxPerSecond)
  }

  private async upsertSearchMetadataWithRetry(metadata: ReturnType<typeof classifySearchMetadata>[]): Promise<void> {
    for (let attempt = 1; attempt <= SEARCH_CLASSIFICATION_MAX_RETRIES; attempt++) {
      try {
        await this.searchMetadataRepository.upsertMany(metadata)
        return
      } catch (error) {
        if (attempt === SEARCH_CLASSIFICATION_MAX_RETRIES) {
          logger('search metadata batch upsert failed after %d attempts: %o', attempt, error)
          break
        }
        logger('search metadata batch upsert attempt %d failed; retrying: %o', attempt, error)
        await delayMs(150 * attempt)
      }
    }

    for (const item of metadata) {
      for (let attempt = 1; attempt <= SEARCH_CLASSIFICATION_MAX_RETRIES; attempt++) {
        try {
          await this.searchMetadataRepository.upsert(item)
          break
        } catch (error) {
          if (attempt === SEARCH_CLASSIFICATION_MAX_RETRIES) {
            logger('search metadata upsert failed for event %s after %d attempts: %o', item.eventId, attempt, error)
          } else {
            await delayMs(100 * attempt)
          }
        }
      }
    }
  }

  private onError(error: Error) {
    logger('error: %o', error)
    throw error
  }

  private onExit() {
    logger('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    logger('closing')
    clearInterval(this.interval)
    if (typeof callback === 'function') {
      callback()
    }
  }
}
