exports.up = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.text('test_column').nullable()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('test_column')
  })
}
