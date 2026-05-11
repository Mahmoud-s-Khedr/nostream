exports.up = async function (knex) {
  await knex.schema.createTable('event_search_metadata', (table) => {
    table.binary('event_id').notNullable().primary()
    table.text('language').nullable()
    table.text('sentiment').nullable()
    table.boolean('nsfw').notNullable().defaultTo(false)
    table.boolean('is_spam').notNullable().defaultTo(false)
    table.text('classifier_version').notNullable()
    table.timestamp('classified_at', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.foreign('event_id').references('events.event_id').onDelete('CASCADE')
  })

  await knex.schema.alterTable('event_search_metadata', (table) => {
    table.index(['language'], 'idx_event_search_metadata_language')
    table.index(['sentiment'], 'idx_event_search_metadata_sentiment')
    table.index(['nsfw'], 'idx_event_search_metadata_nsfw')
    table.index(['is_spam'], 'idx_event_search_metadata_is_spam')
  })

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS events_content_fts_idx
    ON events
    USING GIN (to_tsvector('simple', event_content))
  `)
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS events_content_fts_idx')
  await knex.schema.dropTableIfExists('event_search_metadata')
}
