import { EventId } from './base'

export type SearchSentiment = 'negative' | 'neutral' | 'positive'

export interface SearchMetadata {
  eventId: EventId
  language: string | null
  sentiment: SearchSentiment | null
  nsfw: boolean
  isSpam: boolean
  classifierVersion: string
  classifiedAt: Date
}

export interface DBSearchMetadata {
  event_id: Buffer
  language: string | null
  sentiment: SearchSentiment | null
  nsfw: boolean
  is_spam: boolean
  classifier_version: string
  classified_at: Date
  created_at: Date
  updated_at: Date
}

export interface SearchExtensions {
  includeSpam: boolean
  domain?: string
  language?: string
  sentiment?: SearchSentiment
  nsfw?: boolean
}

export interface ParsedSearchQuery {
  text: string
  extensions: SearchExtensions
}
