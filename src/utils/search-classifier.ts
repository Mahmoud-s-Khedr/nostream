import { SearchMetadata, SearchSentiment } from '../@types/search'

const CLASSIFIER_VERSION = 'v1'
const DEFAULT_MAX_CLASSIFIER_CONTENT_LENGTH = 20000

const parseMaxClassifierContentLength = (raw: string | undefined): number => {
  if (typeof raw === 'undefined') {
    return DEFAULT_MAX_CLASSIFIER_CONTENT_LENGTH
  }

  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_CLASSIFIER_CONTENT_LENGTH
  }

  return parsed
}

const MAX_CLASSIFIER_CONTENT_LENGTH = parseMaxClassifierContentLength(process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH)

const POSITIVE_WORDS = new Set([
  'good',
  'great',
  'awesome',
  'love',
  'excellent',
  'happy',
  'nice',
  'amazing',
  'best',
  'win',
])
const NEGATIVE_WORDS = new Set([
  'bad',
  'terrible',
  'awful',
  'hate',
  'worst',
  'angry',
  'sad',
  'scam',
  'fraud',
  'loss',
])

const NSFW_WORDS = new Set(['nsfw', 'porn', 'xxx', 'nude', 'sex', 'explicit'])
const SPAM_WORDS = new Set(['airdrop', 'giveaway', 'pump', 'moon', 'click', 'free', 'bonus', 'promo'])

const languageRegexes: Array<{ code: string; re: RegExp }> = [
  { code: 'en', re: /\b(the|and|is|are|you|this|that)\b/i },
  { code: 'es', re: /\b(el|la|de|que|y|en)\b/i },
  { code: 'fr', re: /\b(le|la|et|de|les|des)\b/i },
  { code: 'de', re: /\b(der|die|das|und|ist|nicht)\b/i },
]

const detectLanguage = (text: string): string | null => {
  for (const pattern of languageRegexes) {
    if (pattern.re.test(text)) {
      return pattern.code
    }
  }
  return null
}

const sentimentOf = (text: string): SearchSentiment => {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let score = 0
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) {
      score++
    }
    if (NEGATIVE_WORDS.has(word)) {
      score--
    }
  }
  if (score > 0) {
    return 'positive'
  }
  if (score < 0) {
    return 'negative'
  }
  return 'neutral'
}

const hasAnyWord = (text: string, words: Set<string>): boolean => {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return tokens.some((token) => words.has(token))
}

const normalizeContent = (input: unknown): string => {
  if (typeof input !== 'string') {
    return ''
  }

  return input.slice(0, MAX_CLASSIFIER_CONTENT_LENGTH)
}

export const classifySearchMetadata = (
  eventId: string,
  content: unknown,
  classifiedAt: Date = new Date(),
): SearchMetadata => {
  // Empty/invalid text falls back to neutral non-NSFW non-spam metadata.
  const normalizedContent = normalizeContent(content)

  return {
    eventId,
    language: detectLanguage(normalizedContent),
    sentiment: sentimentOf(normalizedContent),
    nsfw: hasAnyWord(normalizedContent, NSFW_WORDS),
    isSpam: hasAnyWord(normalizedContent, SPAM_WORDS),
    classifierVersion: CLASSIFIER_VERSION,
    classifiedAt,
  }
}
