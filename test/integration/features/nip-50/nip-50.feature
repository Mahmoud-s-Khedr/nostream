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

  Scenario: NIP-11 omits NIP-50 extensions when disabled
    Given NIP-50 search is disabled
    When a client requests the relay information document
    Then the supported_nip_extensions field does not include include:spam

  Scenario: Search extensions filter by language, sentiment, and nsfw
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 ext target one"
    And Bob marks the last event with language "en", sentiment "positive", nsfw false, spam false
    And Bob sends a text_note event with content "nip50 ext target two"
    And Bob marks the last event with language "fr", sentiment "negative", nsfw true, spam false
    And Alice subscribes with search "nip50 ext language:en sentiment:positive nsfw:false"
    Then Alice receives 1 search result event from Bob with content "nip50 ext target one"

  Scenario: Search excludes spam by default and includes spam with include:spam
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 spam control"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam true
    And Alice subscribes with search "nip50 spam"
    Then Alice receives 0 search results
    When Alice subscribes with search "nip50 spam include:spam"
    Then Alice receives 1 search result event from Bob with content "nip50 spam control"

  Scenario: Search domain extension returns only verified domain authors
    Given someone called Alice
    And someone called Bob
    And someone called Charlie
    When Bob sends a text_note event with content "nip50 domain target bob"
    And Charlie sends a text_note event with content "nip50 domain target charlie"
    And Bob has verified nip05 domain "example.com"
    And Charlie has verified nip05 domain "other.com"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Charlie marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Alice subscribes with search "nip50 domain domain:example.com"
    Then Alice receives 1 search result event from Bob with content "nip50 domain target bob"

  Scenario: Unknown search extensions are ignored
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 unknown extension sample"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Alice subscribes with search "nip50 unknown extension"
    Then Alice receives 1 search results
    When Alice subscribes with search "nip50 unknown extension custom:token mode:strict"
    Then Alice receives 1 search results

  Scenario: REQ with multiple search filters returns union of results
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 union apples"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Bob sends a text_note event with content "nip50 union bananas"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Alice subscribes with multiple search filters "nip50 union apples" and "nip50 union bananas"
    Then Alice receives 2 search results

  Scenario: Ranked search orders best result first
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 rank apples oranges"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Bob sends a text_note event with content "nip50 rank apples apples apples oranges"
    And Bob marks the last event with language "en", sentiment "neutral", nsfw false, spam false
    And Alice subscribes with search "nip50 rank apples oranges"
    Then Alice receives search results in this content order:
      | nip50 rank apples apples apples oranges |
      | nip50 rank apples oranges               |

  Scenario: COUNT supports search extension filters
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "nip50 count extension one"
    And Bob marks the last event with language "en", sentiment "positive", nsfw false, spam false
    And Bob sends a text_note event with content "nip50 count extension two"
    And Bob marks the last event with language "es", sentiment "positive", nsfw false, spam false
    And Alice counts with search "nip50 count extension language:en sentiment:positive nsfw:false"
    Then Alice receives count result 1
