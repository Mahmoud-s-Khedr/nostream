import { expect } from 'chai'

import { classifySearchMetadata } from '../../../src/utils/search-classifier'

describe('search-classifier', () => {
  it('classifies invalid content with safe defaults', () => {
    const metadata = classifySearchMetadata('a'.repeat(64), null as any)

    expect(metadata.language).to.equal(null)
    expect(metadata.sentiment).to.equal('neutral')
    expect(metadata.nsfw).to.equal(false)
    expect(metadata.isSpam).to.equal(false)
  })

  it('truncates oversized content before classification', () => {
    const metadata = classifySearchMetadata('b'.repeat(64), `${'good '.repeat(10000)}spam`)

    expect(metadata.sentiment).to.equal('positive')
    expect(metadata.isSpam).to.equal(false)
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

    if (previous === undefined) {
      delete process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH
    } else {
      process.env.NOSTREAM_MAX_CLASSIFIER_CONTENT_LENGTH = previous
    }

    delete require.cache[modulePath]
  })
})
