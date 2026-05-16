import { applySpec, map, pipe, prop } from 'ramda'

import { DatabaseClient } from '../@types/base'
import { DBSearchMetadata, SearchMetadata } from '../@types/search'
import { ISearchMetadataRepository } from '../@types/repositories'
import { fromBuffer, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('search-metadata-repository')

const fromDBSearchMetadata = applySpec<SearchMetadata>({
  eventId: pipe(prop('event_id') as () => Buffer, fromBuffer),
  language: prop('language') as () => string | null,
  languageConfidence: prop('language_confidence') as () => number,
  sentiment: prop('sentiment') as () => SearchMetadata['sentiment'],
  sentimentConfidence: prop('sentiment_confidence') as () => number,
  nsfw: prop('nsfw') as () => boolean,
  nsfwConfidence: prop('nsfw_confidence') as () => number,
  isSpam: prop('is_spam') as () => boolean,
  spamConfidence: prop('spam_confidence') as () => number,
  classifierSource: prop('classifier_source') as () => SearchMetadata['classifierSource'],
  classifierVersion: prop('classifier_version') as () => string,
  classifiedAt: prop('classified_at') as () => Date,
})

interface UnclassifiedEventRow {
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_content: string
}

export class SearchMetadataRepository implements ISearchMetadataRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async upsert(metadata: SearchMetadata): Promise<number> {
    logger('upsert metadata for event %s', metadata.eventId)
    const now = new Date()
    const row: DBSearchMetadata = {
      event_id: toBuffer(metadata.eventId),
      language: metadata.language,
      language_confidence: metadata.languageConfidence,
      sentiment: metadata.sentiment,
      sentiment_confidence: metadata.sentimentConfidence,
      nsfw: metadata.nsfw,
      nsfw_confidence: metadata.nsfwConfidence,
      is_spam: metadata.isSpam,
      spam_confidence: metadata.spamConfidence,
      classifier_source: metadata.classifierSource,
      classifier_version: metadata.classifierVersion,
      classified_at: metadata.classifiedAt,
      created_at: now,
      updated_at: now,
    }

    const query = this.dbClient<DBSearchMetadata>('event_search_metadata').insert(row).onConflict('event_id').merge({
      language: row.language,
      language_confidence: row.language_confidence,
      sentiment: row.sentiment,
      sentiment_confidence: row.sentiment_confidence,
      nsfw: row.nsfw,
      nsfw_confidence: row.nsfw_confidence,
      is_spam: row.is_spam,
      spam_confidence: row.spam_confidence,
      classifier_source: row.classifier_source,
      classifier_version: row.classifier_version,
      classified_at: row.classified_at,
      updated_at: now,
    })

    return query.then((result: any) => Number(result?.rowCount ?? 0), () => 0)
  }

  public async findUnclassifiedEvents(
    limit: number,
  ): Promise<Array<{ eventId: string; content: string; pubkey: string; kind: number }>> {
    const rows = await this.dbClient<UnclassifiedEventRow>('events')
      .leftJoin('event_search_metadata', 'events.event_id', 'event_search_metadata.event_id')
      .whereNull('event_search_metadata.event_id')
      .select('events.event_id', 'events.event_pubkey', 'events.event_kind', 'events.event_content')
      .orderBy('events.event_created_at', 'desc')
      .limit(limit)

    return rows.map((row) => ({
      eventId: fromBuffer(row.event_id),
      pubkey: fromBuffer(row.event_pubkey),
      kind: row.event_kind,
      content: row.event_content,
    }))
  }

  public async findByEventId(eventId: string): Promise<SearchMetadata | undefined> {
    const [row] = await this.dbClient<DBSearchMetadata>('event_search_metadata')
      .where('event_id', toBuffer(eventId))
      .select()
      .limit(1)

    if (!row) {
      return undefined
    }
    return fromDBSearchMetadata(row)
  }

  public async upsertMany(metadata: SearchMetadata[]): Promise<number> {
    if (!metadata.length) {
      return 0
    }
    const inserted = await Promise.all(map((entry) => this.upsert(entry), metadata))
    return inserted.reduce((acc, current) => acc + current, 0)
  }
}
