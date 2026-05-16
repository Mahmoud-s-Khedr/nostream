import { expect } from 'chai'

import { parseSearchQuery } from '../../../src/utils/search-query'

describe('search-query', () => {
  describe('parseSearchQuery', () => {
    it('extracts supported extension tokens', () => {
      const parsed = parseSearchQuery(
        'best nostr apps include:spam domain:example.com language:en sentiment:positive nsfw:false',
      )

      expect(parsed.text).to.equal('best nostr apps')
      expect(parsed.extensions).to.deep.equal({
        includeSpam: true,
        domain: 'example.com',
        language: 'en',
        sentiment: 'positive',
        nsfw: false,
      })
    })

    it('ignores malformed known extension tokens', () => {
      const parsed = parseSearchQuery('hello language:english sentiment:meh nsfw:nope')

      expect(parsed.text).to.equal('hello')
      expect(parsed.extensions).to.deep.equal({ includeSpam: false })
    })

    it('ignores unknown key:value tokens', () => {
      const parsed = parseSearchQuery('best nostr apps custom:token mode:strict')

      expect(parsed.text).to.equal('best nostr apps')
      expect(parsed.extensions).to.deep.equal({ includeSpam: false })
    })

    it('supports extension-only query', () => {
      const parsed = parseSearchQuery('domain:example.com include:spam')

      expect(parsed.text).to.equal('')
      expect(parsed.extensions.includeSpam).to.equal(true)
      expect(parsed.extensions.domain).to.equal('example.com')
    })
  })
})
