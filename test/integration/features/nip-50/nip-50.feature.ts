import { After, Given, Then, When, World } from '@cucumber/cucumber'
import chai from 'chai'
import { WebSocket } from 'ws'

import { MessageType } from '../../../../src/@types/messages'
import { SettingsStatic } from '../../../../src/utils/settings'
import { createCountQuery, createSubscription, waitForCountOrClosed, waitForEventCount } from '../helpers'

chai.use(require('sinon-chai'))
const { expect } = chai

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

When(/^(\w+) counts with search "([^"]+)"$/, async function(this: World<Record<string, any>>, name: string, search: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const queryId = `count-${Math.random()}`
  this.parameters.countQueryId = queryId

  await createCountQuery(ws, queryId, [{ kinds: [1], search }])
})

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
