Feature: NIP-50
  Scenario: REQ search returns matching events
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nostr search apples"
    And Bob sends a text_note event with content "nostr search oranges"
    And Alice subscribes with search "apples"
    Then Alice receives 1 search result event from Bob with content "nostr search apples"

  Scenario: COUNT search returns expected count
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nostr count bananas"
    And Bob sends a text_note event with content "nostr count bananas again"
    And Alice counts with search "bananas"
    Then Alice receives count result 2

  Scenario: Search is rejected when nip50 is disabled
    Given someone called Alice
    And NIP-50 search is disabled
    When Alice subscribes with search "nostr"
    Then Alice receives a notice with NIP-50 search is disabled by relay configuration
    When Alice counts with search "nostr"
    Then Alice receives closed reason "NIP-50 search is disabled by relay configuration"

  Scenario: NIP-11 omits NIP-50 when disabled
    Given NIP-50 search is disabled
    When a client requests the relay information document
    Then the supported_nips field does not include 50
