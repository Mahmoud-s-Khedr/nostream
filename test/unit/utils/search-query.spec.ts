import { expect } from 'chai'

import { parseSearchQuery } from '../../../src/utils/search-query'

describe('search-query', () => {
  describe('parseSearchQuery', () => {
    it('preserves plain text tokens', () => {
      const parsed = parseSearchQuery('best nostr apps')

      expect(parsed.text).to.equal('best nostr apps')
    })

    it('ignores supported extension-shaped tokens', () => {
      const parsed = parseSearchQuery(
        'best nostr apps include:spam domain:example.com language:en sentiment:positive nsfw:false',
      )

      expect(parsed.text).to.equal('best nostr apps')
    })

    it('ignores unknown key:value tokens', () => {
      const parsed = parseSearchQuery('best nostr apps custom:token mode:strict')

      expect(parsed.text).to.equal('best nostr apps')
    })

    it('reduces extension-only queries to empty text', () => {
      const parsed = parseSearchQuery('domain:example.com include:spam')

      expect(parsed.text).to.equal('')
    })
  })
})
