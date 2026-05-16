import { ParsedSearchQuery, SearchExtensions, SearchSentiment } from '../@types/search'

const isIso639_1 = (value: string): boolean => /^[a-z]{2}$/i.test(value)

const toSentiment = (value: string): SearchSentiment | undefined => {
  switch (value.toLowerCase()) {
    case 'negative':
    case 'neutral':
    case 'positive':
      return value.toLowerCase() as SearchSentiment
    default:
      return undefined
  }
}

const toBoolean = (value: string): boolean | undefined => {
  if (value.toLowerCase() === 'true') {
    return true
  }
  if (value.toLowerCase() === 'false') {
    return false
  }
  return undefined
}

const defaultExtensions = (): SearchExtensions => ({
  includeSpam: false,
})

export const parseSearchQuery = (query: string): ParsedSearchQuery => {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const extensions = defaultExtensions()
  const textTokens: string[] = []

  for (const token of tokens) {
    const sep = token.indexOf(':')
    if (sep <= 0 || sep === token.length - 1) {
      textTokens.push(token)
      continue
    }

    const key = token.slice(0, sep).toLowerCase()
    const value = token.slice(sep + 1)

    if (key === 'include') {
      if (value.toLowerCase() === 'spam') {
        extensions.includeSpam = true
      }
      // Known extension key with unsupported value: ignore token.
      continue
    }

    if (key === 'domain') {
      extensions.domain = value.toLowerCase()
      continue
    }

    if (key === 'language') {
      if (isIso639_1(value)) {
        extensions.language = value.toLowerCase()
      }
      // Known extension key with unsupported value: ignore token.
      continue
    }

    if (key === 'sentiment') {
      const sentiment = toSentiment(value)
      if (sentiment) {
        extensions.sentiment = sentiment
      }
      // Known extension key with unsupported value: ignore token.
      continue
    }

    if (key === 'nsfw') {
      const nsfw = toBoolean(value)
      if (typeof nsfw === 'boolean') {
        extensions.nsfw = nsfw
      }
      // Known extension key with unsupported value: ignore token.
      continue
    }

    // Unknown key:value extension is ignored per NIP-50.
    continue
  }

  return {
    text: textTokens.join(' ').trim(),
    extensions,
  }
}

export const hasSearchExtensions = (extensions: SearchExtensions): boolean =>
  extensions.includeSpam ||
  typeof extensions.domain === 'string' ||
  typeof extensions.language === 'string' ||
  typeof extensions.sentiment === 'string' ||
  typeof extensions.nsfw === 'boolean'
