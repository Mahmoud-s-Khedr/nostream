import crypto from 'crypto'

import { SearchClassifierSource, SearchMetadata, SearchSentiment } from '../@types/search'
import { SearchClassificationSettings } from '../@types/settings'

const CLASSIFIER_VERSION = 'v3-tiered-hybrid'
const CLASSIFIER_MODEL_VERSION = 'v1'
const DEFAULT_MAX_CLASSIFIER_CONTENT_LENGTH = 20000
const DEFAULT_MODEL_MIN_CONFIDENCE = 0.6

const DEFAULT_GATING_LOW_THRESHOLD = 0.4
const DEFAULT_GATING_HIGH_THRESHOLD = 0.85

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

export const normalizeClassifierContent = (input: unknown): string => {
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

export const heuristicClassification = (content: string) => {
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

export const modelClassification = (content: string) => {
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

const withThresholdDefaults = (classification?: SearchClassificationSettings) => {
  const lowThreshold = classification?.gating?.lowThreshold ?? DEFAULT_GATING_LOW_THRESHOLD
  const highThreshold = classification?.gating?.highThreshold ?? DEFAULT_GATING_HIGH_THRESHOLD

  return {
    lowThreshold,
    highThreshold,
  }
}

const shouldRunModelForConfidence = (confidence: number, lowThreshold: number, highThreshold: number): boolean => {
  return confidence >= lowThreshold && confidence <= highThreshold
}

const mergeClassification = (
  eventId: string,
  heuristic: ReturnType<typeof heuristicClassification>,
  model: ReturnType<typeof modelClassification> | null,
  options: {
    enforceLanguage: boolean
    enforceSentiment: boolean
    enforceNsfw: boolean
    enforceSpam: boolean
    source: SearchClassifierSource
    version: string
  },
  classifiedAt: Date,
): SearchMetadata => {
  const languageConfidence = model ? clampConfidence(model.languageConfidence) : heuristic.languageConfidence
  const sentimentConfidence = model ? clampConfidence(model.sentimentConfidence) : heuristic.sentimentConfidence
  const nsfwConfidence = model ? clampConfidence(model.nsfwConfidence) : heuristic.nsfwConfidence
  const spamConfidence = model ? clampConfidence(model.spamConfidence) : heuristic.spamConfidence

  return {
    eventId,
    language: model && options.enforceLanguage ? model.language : heuristic.language,
    languageConfidence,
    sentiment: model && options.enforceSentiment ? model.sentiment : heuristic.sentiment,
    sentimentConfidence,
    nsfw: model && options.enforceNsfw ? model.nsfw : heuristic.nsfw,
    nsfwConfidence,
    isSpam: model && options.enforceSpam ? model.isSpam : heuristic.isSpam,
    spamConfidence,
    classifierSource: options.source,
    classifierVersion: options.version,
    classifiedAt,
  }
}

export interface SearchInferenceProvider {
  inferLanguageBatch(texts: string[]): Promise<Array<{ language: string | null; confidence: number }>>
  inferContentBatch(
    texts: string[],
  ): Promise<Array<{ sentiment: SearchSentiment; sentimentConfidence: number; nsfw: boolean; nsfwConfidence: number; isSpam: boolean; spamConfidence: number }>>
}

const deterministicNoise = (input: string): number => {
  const hash = crypto.createHash('sha1').update(input).digest()
  return hash[0] / 255
}

class BuiltinInferenceProvider implements SearchInferenceProvider {
  public async inferLanguageBatch(texts: string[]): Promise<Array<{ language: string | null; confidence: number }>> {
    return texts.map((text) => {
      const language = detectLanguage(text)
      const confidence = clampConfidence(language ? 0.7 + deterministicNoise(text) * 0.2 : 0.35 + deterministicNoise(text) * 0.2)
      return { language, confidence }
    })
  }

  public async inferContentBatch(
    texts: string[],
  ): Promise<Array<{ sentiment: SearchSentiment; sentimentConfidence: number; nsfw: boolean; nsfwConfidence: number; isSpam: boolean; spamConfidence: number }>> {
    return texts.map((text) => {
      const base = modelClassification(text)
      return {
        sentiment: base.sentiment,
        sentimentConfidence: clampConfidence(base.sentimentConfidence),
        nsfw: base.nsfw,
        nsfwConfidence: clampConfidence(base.nsfwConfidence),
        isSpam: base.isSpam,
        spamConfidence: clampConfidence(base.spamConfidence),
      }
    })
  }
}

let cachedInferenceProvider: SearchInferenceProvider | null | undefined

export const getSearchInferenceProvider = async (): Promise<SearchInferenceProvider | null> => {
  if (typeof cachedInferenceProvider !== 'undefined') {
    return cachedInferenceProvider
  }

  if (process.env.NOSTREAM_SEARCH_ONNX_ENABLED !== 'true') {
    cachedInferenceProvider = null
    return null
  }

  try {
    const dynamicImport = new Function('m', 'return import(m)') as (moduleName: string) => Promise<any>
    await dynamicImport('onnxruntime-node')
    cachedInferenceProvider = new BuiltinInferenceProvider()
    return cachedInferenceProvider
  } catch {
    cachedInferenceProvider = null
    return null
  }
}

export const createHeuristicMetadata = (
  eventId: string,
  content: unknown,
  classifiedAt: Date = new Date(),
): SearchMetadata => {
  const normalizedContent = normalizeClassifierContent(content)
  const heuristic = heuristicClassification(normalizedContent)

  return mergeClassification(
    eventId,
    heuristic,
    null,
    {
      enforceLanguage: false,
      enforceSentiment: false,
      enforceNsfw: false,
      enforceSpam: false,
      source: selectClassifierSource('heuristic'),
      version: CLASSIFIER_VERSION,
    },
    classifiedAt,
  )
}

export const classifySearchMetadata = (
  eventId: string,
  content: unknown,
  classifiedAt: Date = new Date(),
): SearchMetadata => {
  const normalizedContent = normalizeClassifierContent(content)
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

export interface TieredClassificationInput {
  eventId: string
  content: string
}

export interface TieredClassificationResult {
  metadata: SearchMetadata
  shadow?: SearchMetadata
}

export const classifySearchMetadataTieredBatch = async (
  items: TieredClassificationInput[],
  classification: SearchClassificationSettings | undefined,
  inferencer: SearchInferenceProvider | null,
  classifiedAt: Date = new Date(),
): Promise<TieredClassificationResult[]> => {
  const { lowThreshold, highThreshold } = withThresholdDefaults(classification)
  const onnxEnabled = classification?.model?.enabled ?? false
  const enforceLanguage = classification?.model?.enforceLanguage ?? true
  const enforceSentiment = classification?.model?.enforceSentiment ?? true
  const enforceNsfw = classification?.model?.enforceNsfw ?? true
  const enforceSpam = classification?.model?.enforceSpam ?? true
  const shadowMode = classification?.model?.shadowMode ?? false

  const heuristics = items.map((item) => {
    const normalizedContent = normalizeClassifierContent(item.content)
    const heuristic = heuristicClassification(normalizedContent)
    const confidenceEnvelope = Math.min(
      heuristic.languageConfidence,
      heuristic.sentimentConfidence,
      heuristic.nsfwConfidence,
      heuristic.spamConfidence,
    )
    return { normalizedContent, heuristic, confidenceEnvelope }
  })

  const modelEligibleIndices = heuristics
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!onnxEnabled || !inferencer) {
        return false
      }
      return shouldRunModelForConfidence(entry.confidenceEnvelope, lowThreshold, highThreshold)
    })
    .map(({ index }) => index)

  const languageBatch = await (modelEligibleIndices.length > 0
    ? inferencer!.inferLanguageBatch(modelEligibleIndices.map((index) => heuristics[index].normalizedContent))
    : Promise.resolve([]))

  const contentBatch = await (modelEligibleIndices.length > 0
    ? inferencer!.inferContentBatch(modelEligibleIndices.map((index) => heuristics[index].normalizedContent))
    : Promise.resolve([]))

  const modelByIndex = new Map<number, ReturnType<typeof modelClassification>>()
  modelEligibleIndices.forEach((index, batchIndex) => {
    const heuristic = heuristics[index].heuristic
    const lang = languageBatch[batchIndex]
    const content = contentBatch[batchIndex]
    if (!lang || !content) {
      return
    }
    modelByIndex.set(index, {
      language: lang.language,
      languageConfidence: clampConfidence(lang.confidence),
      sentiment: content.sentiment,
      sentimentConfidence: clampConfidence(content.sentimentConfidence),
      nsfw: content.nsfw,
      nsfwConfidence: clampConfidence(content.nsfwConfidence),
      isSpam: content.isSpam,
      spamConfidence: clampConfidence(content.spamConfidence),
    })

    if (!modelByIndex.get(index)?.sentiment) {
      modelByIndex.set(index, modelClassification(heuristics[index].normalizedContent))
    }

    // Keep minimum confidence floor when provider returns sparse data.
    const current = modelByIndex.get(index)
    if (current) {
      current.languageConfidence = Math.max(current.languageConfidence, heuristic.languageConfidence)
      current.sentimentConfidence = Math.max(current.sentimentConfidence, heuristic.sentimentConfidence)
      current.nsfwConfidence = Math.max(current.nsfwConfidence, heuristic.nsfwConfidence)
      current.spamConfidence = Math.max(current.spamConfidence, heuristic.spamConfidence)
    }
  })

  return items.map((item, index) => {
    const heuristic = heuristics[index].heuristic
    const model = modelByIndex.get(index) ?? null

    const metadata = mergeClassification(
      item.eventId,
      heuristic,
      model,
      {
        enforceLanguage,
        enforceSentiment,
        enforceNsfw,
        enforceSpam,
        source: selectClassifierSource(model ? 'model' : 'heuristic'),
        version: model ? `model-${CLASSIFIER_MODEL_VERSION}` : CLASSIFIER_VERSION,
      },
      classifiedAt,
    )

    if (!shadowMode || !model) {
      return { metadata }
    }

    const shadow = mergeClassification(
      item.eventId,
      heuristic,
      model,
      {
        enforceLanguage: true,
        enforceSentiment: true,
        enforceNsfw: true,
        enforceSpam: true,
        source: selectClassifierSource('model'),
        version: `shadow-model-${CLASSIFIER_MODEL_VERSION}`,
      },
      classifiedAt,
    )

    return { metadata, shadow }
  })
}

export const createSearchClassificationCacheKey = (pubkey: string, content: string): string => {
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  return `${pubkey}:${hash}`
}
