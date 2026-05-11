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
  sentiment: prop('sentiment') as () => SearchMetadata['sentiment'],
  nsfw: prop('nsfw') as () => boolean,
  isSpam: prop('is_spam') as () => boolean,
  classifierVersion: prop('classifier_version') as () => string,
  classifiedAt: prop('classified_at') as () => Date,
})

interface UnclassifiedEventRow {
  event_id: Buffer
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
      sentiment: metadata.sentiment,
      nsfw: metadata.nsfw,
      is_spam: metadata.isSpam,
      classifier_version: metadata.classifierVersion,
      classified_at: metadata.classifiedAt,
      created_at: now,
      updated_at: now,
    }

    const query = this.dbClient<DBSearchMetadata>('event_search_metadata').insert(row).onConflict('event_id').merge({
      language: row.language,
      sentiment: row.sentiment,
      nsfw: row.nsfw,
      is_spam: row.is_spam,
      classifier_version: row.classifier_version,
      classified_at: row.classified_at,
      updated_at: now,
    })

    return query.then((result: any) => Number(result?.rowCount ?? 0), () => 0)
  }

  public async findUnclassifiedEvents(limit: number): Promise<Array<{ eventId: string; content: string }>> {
    const rows = await this.dbClient<UnclassifiedEventRow>('events')
      .leftJoin('event_search_metadata', 'events.event_id', 'event_search_metadata.event_id')
      .whereNull('event_search_metadata.event_id')
      .select('events.event_id', 'events.event_content')
      .orderBy('events.event_created_at', 'desc')
      .limit(limit)

    return rows.map((row) => ({
      eventId: fromBuffer(row.event_id),
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
