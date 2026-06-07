import { expect } from 'chai'

import {
  classifySearchMetadata,
  classifySearchMetadataTieredBatch,
  createSearchClassificationCacheKey,
} from '../../../src/utils/search-classifier'

describe('search-classifier', () => {
  it('classifies invalid content with safe defaults', () => {
    const metadata = classifySearchMetadata('a'.repeat(64), null as any)

    expect(metadata.language).to.equal(null)
    expect(metadata.languageConfidence).to.be.a('number')
    expect(metadata.sentiment).to.equal('neutral')
    expect(metadata.sentimentConfidence).to.be.a('number')
    expect(metadata.nsfw).to.equal(false)
    expect(metadata.nsfwConfidence).to.be.a('number')
    expect(metadata.isSpam).to.equal(false)
    expect(metadata.spamConfidence).to.be.a('number')
    expect(metadata.classifierSource).to.be.oneOf(['heuristic', 'model'])
  })

  it('truncates oversized content before classification', () => {
    const metadata = classifySearchMetadata('b'.repeat(64), `${'good '.repeat(10000)}spam`)

    expect(metadata.sentiment).to.equal('positive')
    expect(metadata.isSpam).to.equal(false)
    expect(metadata.classifierVersion).to.be.a('string')
  })

  it('respects NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH when module is loaded', () => {
    const previous = process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH
    process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH = '4'

    const modulePath = require.resolve('../../../src/utils/search-classifier')
    delete require.cache[modulePath]
    const mod = require('../../../src/utils/search-classifier') as typeof import('../../../src/utils/search-classifier')
    const metadata = mod.classifySearchMetadata('c'.repeat(64), 'good spam')

    expect(metadata.sentiment).to.equal('positive')
    expect(metadata.isSpam).to.equal(false)
    expect(metadata.classifierSource).to.be.oneOf(['heuristic', 'model'])

    if (previous === undefined) {
      delete process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH
    } else {
      process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH = previous
    }

    delete require.cache[modulePath]
  })

  it('falls back to heuristic classifier when model confidence threshold is too high', () => {
    const previousThreshold = process.env.NOSTREAM_SEARCH_MODEL_MIN_CONFIDENCE
    process.env.NOSTREAM_SEARCH_MODEL_MIN_CONFIDENCE = '0.9999'

    const modulePath = require.resolve('../../../src/utils/search-classifier')
    delete require.cache[modulePath]
    const mod = require('../../../src/utils/search-classifier') as typeof import('../../../src/utils/search-classifier')
    const metadata = mod.classifySearchMetadata('d'.repeat(64), 'the awesome giveaway')

    expect(metadata.classifierSource).to.equal('heuristic')

    if (previousThreshold === undefined) {
      delete process.env.NOSTREAM_SEARCH_MODEL_MIN_CONFIDENCE
    } else {
      process.env.NOSTREAM_SEARCH_MODEL_MIN_CONFIDENCE = previousThreshold
    }

    delete require.cache[modulePath]
  })

  it('runs tiered classification with model path for middle-band confidence only', async () => {
    const result = await classifySearchMetadataTieredBatch(
      [{ eventId: 'e'.repeat(64), content: 'the giveaway is awesome' }],
      {
        model: {
          enabled: true,
        },
        gating: {
          lowThreshold: 0.5,
          highThreshold: 0.9,
        },
      } as any,
      {
        inferLanguageBatch: async () => [{ language: 'en', confidence: 0.9 }],
        inferContentBatch: async () => [
          {
            sentiment: 'positive',
            sentimentConfidence: 0.9,
            nsfw: false,
            nsfwConfidence: 0.9,
            isSpam: true,
            spamConfidence: 0.9,
          },
        ],
      },
    )

    expect(result).to.have.length(1)
    expect(result[0].metadata.classifierSource).to.equal('model')
    expect(result[0].metadata.language).to.equal('en')
    expect(result[0].metadata.isSpam).to.equal(true)
  })

  it('builds stable cache keys for pubkey/content', () => {
    const keyA = createSearchClassificationCacheKey('f'.repeat(64), 'hello world')
    const keyB = createSearchClassificationCacheKey('f'.repeat(64), 'hello world')
    const keyC = createSearchClassificationCacheKey('f'.repeat(64), 'hello world 2')

    expect(keyA).to.equal(keyB)
    expect(keyA).to.not.equal(keyC)
  })
})
