import { EventId } from './base'

export type SearchSentiment = 'negative' | 'neutral' | 'positive'
export type SearchClassifierSource = 'model' | 'heuristic'

export interface SearchMetadata {
  eventId: EventId
  language: string | null
  languageConfidence: number
  sentiment: SearchSentiment | null
  sentimentConfidence: number
  nsfw: boolean
  nsfwConfidence: number
  isSpam: boolean
  spamConfidence: number
  classifierSource: SearchClassifierSource
  classifierVersion: string
  classifiedAt: Date
}

export interface DBSearchMetadata {
  event_id: Buffer
  language: string | null
  language_confidence: number
  sentiment: SearchSentiment | null
  sentiment_confidence: number
  nsfw: boolean
  nsfw_confidence: number
  is_spam: boolean
  spam_confidence: number
  classifier_source: SearchClassifierSource
  classifier_version: string
  classified_at: Date
  created_at: Date
  updated_at: Date
}

export interface ParsedSearchQuery {
  text: string
}
