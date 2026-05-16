import { After, Given, Then, When, World } from '@cucumber/cucumber'
import chai from 'chai'
import { WebSocket } from 'ws'

import { MessageType } from '../../../../src/@types/messages'
import { getMasterDbClient } from '../../../../src/database/client'
import { SettingsStatic } from '../../../../src/utils/settings'
import { createCountQuery, createSubscription, waitForCountOrClosed, waitForEventCount } from '../helpers'

chai.use(require('sinon-chai'))
const { expect } = chai
const dbClient = getMasterDbClient()

After(function () {
  if (SettingsStatic._settings) {
    SettingsStatic._settings = {
      ...SettingsStatic._settings,
      nip50: { enabled: true },
    } as any
  }
})

Given('NIP-50 search is disabled', function () {
  SettingsStatic._settings = {
    ...SettingsStatic.createSettings(),
    nip50: { enabled: false },
  } as any
})

When(/^(\w+) subscribes with search "([^"]+)"$/, async function(this: World<Record<string, any>>, name: string, search: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = { name: `search-${Math.random()}`, filters: [{ kinds: [1], search }] }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(
  /^(\w+) subscribes with multiple search filters "([^"]+)" and "([^"]+)"$/,
  async function (this: World<Record<string, any>>, name: string, firstSearch: string, secondSearch: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = {
      name: `search-${Math.random()}`,
      filters: [
        { kinds: [1], search: firstSearch },
        { kinds: [1], search: secondSearch },
      ],
    }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

Then(
  /^(\w+) receives (\d+) search result event from (\w+) with content "([^"]+)"$/,
  async function (this: World<Record<string, any>>, name: string, count: string, author: string, content: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, Number(count), true)

    expect(events).to.have.length(Number(count))
    expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(events[0].content).to.equal(content)
  },
)

Then(/^(\w+) receives (\d+) search results$/, async function(this: World<Record<string, any>>, name: string, count: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events).to.have.length(Number(count))
})

Then(
  /^(\w+) receives search results in this content order:$/,
  async function (this: World<Record<string, any>>, name: string, table: { raw(): string[][] }) {
    const ws = this.parameters.clients[name] as WebSocket
    const expectedContents = table
      .raw()
      .flat()
      .map((value) => value.trim())
      .filter(Boolean)
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, expectedContents.length, true)
    const actualContents = events.map((event) => event.content)

    expect(actualContents).to.deep.equal(expectedContents)
  },
)

When(/^(\w+) counts with search "([^"]+)"$/, async function(this: World<Record<string, any>>, name: string, search: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const queryId = `count-${Math.random()}`
  this.parameters.countQueryId = queryId

  await createCountQuery(ws, queryId, [{ kinds: [1], search }])
})

When(
  /^(\w+) marks the last event with language "([^"]+)", sentiment "([^"]+)", nsfw (true|false), spam (true|false)$/,
  async function (
    this: World<Record<string, any>>,
    name: string,
    language: string,
    sentiment: 'negative' | 'neutral' | 'positive',
    nsfw: string,
    spam: string,
  ) {
    const event = this.parameters.events[name][this.parameters.events[name].length - 1]
    expect(event).to.exist

    await dbClient('event_search_metadata')
      .insert({
        event_id: Buffer.from(event.id, 'hex'),
        language,
        language_confidence: 1,
        sentiment,
        sentiment_confidence: 1,
        nsfw: nsfw === 'true',
        nsfw_confidence: 1,
        is_spam: spam === 'true',
        spam_confidence: 1,
        classifier_source: 'heuristic',
        classifier_version: 'integration-test',
        classified_at: dbClient.fn.now(),
      })
      .onConflict('event_id')
      .merge()
  },
)

When(
  /^(\w+) has verified nip05 domain "([^"]+)"$/,
  async function (this: World<Record<string, any>>, name: string, domain: string) {
    const { pubkey } = this.parameters.identities[name]
    await dbClient('nip05_verifications')
      .insert({
        pubkey: Buffer.from(pubkey, 'hex'),
        nip05: `${name.toLowerCase()}@${domain}`,
        domain,
        is_verified: true,
        last_verified_at: dbClient.fn.now(),
        last_checked_at: dbClient.fn.now(),
        failure_count: 0,
        created_at: dbClient.fn.now(),
        updated_at: dbClient.fn.now(),
      })
      .onConflict('pubkey')
      .merge({
        nip05: `${name.toLowerCase()}@${domain}`,
        domain,
        is_verified: true,
        last_verified_at: dbClient.fn.now(),
        last_checked_at: dbClient.fn.now(),
        failure_count: 0,
        updated_at: dbClient.fn.now(),
      })
  },
)

Then(/^(\w+) receives count result (\d+)$/, async function(this: World<Record<string, any>>, name: string, expectedCount: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const message = await waitForCountOrClosed(ws, this.parameters.countQueryId)

  expect(message[0]).to.equal(MessageType.COUNT)
  expect((message as any)[2].count).to.equal(Number(expectedCount))
})

Then(
  /^(\w+) receives closed reason "([^"]+)"$/,
  async function (this: World<Record<string, any>>, name: string, reason: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const message = await waitForCountOrClosed(ws, this.parameters.countQueryId)

    expect(message[0]).to.equal(MessageType.CLOSED)
    expect((message as any)[2]).to.equal(reason)
  },
)

Then('the supported_nips field does not include 50', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  expect(doc.supported_nips).to.not.include(50)
})

Then('the supported_nip_extensions field does not include include:spam', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  expect(doc.supported_nip_extensions).to.not.include('include:spam')
})
