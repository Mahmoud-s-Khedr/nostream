import { SearchClassifierSource, SearchMetadata, SearchSentiment } from '../@types/search'

const CLASSIFIER_VERSION = 'v2-hybrid'
const CLASSIFIER_MODEL_VERSION = 'v1'
const DEFAULT_MAX_CLASSIFIER_CONTENT_LENGTH = 20000
const DEFAULT_MODEL_MIN_CONFIDENCE = 0.6

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
const MODEL_MIN_CONFIDENCE = Number(process.env.NOSTREAM_SEARCH_MODEL_MIN_CONFIDENCE ?? DEFAULT_MODEL_MIN_CONFIDENCE)

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

const clampConfidence = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0
  }
  if (value < 0) {
    return 0
  }
  if (value > 1) {
    return 1
  }
  return Number(value.toFixed(4))
}

const countMatches = (text: string, words: Set<string>): number => {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return tokens.reduce((acc, token) => (words.has(token) ? acc + 1 : acc), 0)
}

const heuristicClassification = (content: string) => {
  return {
    language: detectLanguage(content),
    languageConfidence: content.length === 0 ? 0 : 0.6,
    sentiment: sentimentOf(content),
    sentimentConfidence: content.length === 0 ? 0 : 0.65,
    nsfw: hasAnyWord(content, NSFW_WORDS),
    nsfwConfidence: content.length === 0 ? 0 : 0.75,
    isSpam: hasAnyWord(content, SPAM_WORDS),
    spamConfidence: content.length === 0 ? 0 : 0.75,
  }
}

const modelClassification = (content: string) => {
  const tokenCount = content.split(/[^a-z0-9]+/i).filter(Boolean).length
  const evidenceScale = Math.min(1, tokenCount / 40)

  const positiveCount = countMatches(content, POSITIVE_WORDS)
  const negativeCount = countMatches(content, NEGATIVE_WORDS)
  const sentimentDelta = Math.abs(positiveCount - negativeCount)
  const sentimentConfidence = clampConfidence(0.45 + 0.2 * evidenceScale + 0.12 * Math.min(3, sentimentDelta))

  const sentiment: SearchSentiment =
    positiveCount === negativeCount ? 'neutral' : positiveCount > negativeCount ? 'positive' : 'negative'

  const nsfwCount = countMatches(content, NSFW_WORDS)
  const spamCount = countMatches(content, SPAM_WORDS)

  const language = detectLanguage(content)
  const languageConfidence = clampConfidence(language ? 0.55 + 0.25 * evidenceScale : 0.3 * evidenceScale)

  const nsfwConfidence = clampConfidence(0.4 + Math.min(0.45, nsfwCount * 0.18) + 0.1 * evidenceScale)
  const spamConfidence = clampConfidence(0.4 + Math.min(0.45, spamCount * 0.18) + 0.1 * evidenceScale)

  return {
    language,
    languageConfidence,
    sentiment,
    sentimentConfidence,
    nsfw: nsfwCount > 0,
    nsfwConfidence,
    isSpam: spamCount > 0,
    spamConfidence,
  }
}

const useModelClassification = (normalizedContent: string): boolean => {
  return normalizedContent.length > 0
}

const selectClassifierSource = (source: SearchClassifierSource): SearchClassifierSource => source

export const classifySearchMetadata = (
  eventId: string,
  content: unknown,
  classifiedAt: Date = new Date(),
): SearchMetadata => {
  const normalizedContent = normalizeContent(content)
  const heuristic = heuristicClassification(normalizedContent)
  const model = useModelClassification(normalizedContent) ? modelClassification(normalizedContent) : heuristic

  const languageConfidence = clampConfidence(model.languageConfidence)
  const sentimentConfidence = clampConfidence(model.sentimentConfidence)
  const nsfwConfidence = clampConfidence(model.nsfwConfidence)
  const spamConfidence = clampConfidence(model.spamConfidence)

  const canUseModelLanguage = languageConfidence >= MODEL_MIN_CONFIDENCE
  const canUseModelSentiment = sentimentConfidence >= MODEL_MIN_CONFIDENCE
  const canUseModelNsfw = nsfwConfidence >= MODEL_MIN_CONFIDENCE
  const canUseModelSpam = spamConfidence >= MODEL_MIN_CONFIDENCE
  const usedModel = canUseModelLanguage && canUseModelSentiment && canUseModelNsfw && canUseModelSpam

  return {
    eventId,
    language: canUseModelLanguage ? model.language : heuristic.language,
    languageConfidence: canUseModelLanguage ? languageConfidence : heuristic.languageConfidence,
    sentiment: canUseModelSentiment ? model.sentiment : heuristic.sentiment,
    sentimentConfidence: canUseModelSentiment ? sentimentConfidence : heuristic.sentimentConfidence,
    nsfw: canUseModelNsfw ? model.nsfw : heuristic.nsfw,
    nsfwConfidence: canUseModelNsfw ? nsfwConfidence : heuristic.nsfwConfidence,
    isSpam: canUseModelSpam ? model.isSpam : heuristic.isSpam,
    spamConfidence: canUseModelSpam ? spamConfidence : heuristic.spamConfidence,
    classifierSource: selectClassifierSource(usedModel ? 'model' : 'heuristic'),
    classifierVersion: usedModel ? `model-${CLASSIFIER_MODEL_VERSION}` : CLASSIFIER_VERSION,
    classifiedAt,
  }
}
