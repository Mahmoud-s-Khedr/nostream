exports.up = async function (knex) {
  await knex.schema.alterTable('event_search_metadata', (table) => {
    table.decimal('language_confidence', 5, 4).notNullable().defaultTo(0)
    table.decimal('sentiment_confidence', 5, 4).notNullable().defaultTo(0)
    table.decimal('nsfw_confidence', 5, 4).notNullable().defaultTo(0)
    table.decimal('spam_confidence', 5, 4).notNullable().defaultTo(0)
    table.text('classifier_source').notNullable().defaultTo('heuristic')
  })

  await knex.schema.alterTable('event_search_metadata', (table) => {
    table.index(['classifier_source'], 'idx_event_search_metadata_classifier_source')
    table.index(['language', 'is_spam'], 'idx_event_search_metadata_language_is_spam')
    table.index(['sentiment', 'is_spam'], 'idx_event_search_metadata_sentiment_is_spam')
    table.index(['nsfw', 'is_spam'], 'idx_event_search_metadata_nsfw_is_spam')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('event_search_metadata', (table) => {
    table.dropIndex(['classifier_source'], 'idx_event_search_metadata_classifier_source')
    table.dropIndex(['language', 'is_spam'], 'idx_event_search_metadata_language_is_spam')
    table.dropIndex(['sentiment', 'is_spam'], 'idx_event_search_metadata_sentiment_is_spam')
    table.dropIndex(['nsfw', 'is_spam'], 'idx_event_search_metadata_nsfw_is_spam')
  })

  await knex.schema.alterTable('event_search_metadata', (table) => {
    table.dropColumn('language_confidence')
    table.dropColumn('sentiment_confidence')
    table.dropColumn('nsfw_confidence')
    table.dropColumn('spam_confidence')
    table.dropColumn('classifier_source')
  })
}
