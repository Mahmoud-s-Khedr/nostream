import { ParsedSearchQuery } from '../@types/search'

export const parseSearchQuery = (query: string): ParsedSearchQuery => {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const textTokens: string[] = []

  for (const token of tokens) {
    const sep = token.indexOf(':')
    if (sep <= 0 || sep === token.length - 1) {
      textTokens.push(token)
      continue
    }

    // Any key:value token is treated as an unsupported extension and ignored.
    continue
  }

  return {
    text: textTokens.join(' ').trim(),
  }
}
