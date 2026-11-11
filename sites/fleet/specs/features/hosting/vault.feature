@hosting @startup @vault
Feature: Settings can come from Vault
  With VAULT_ADDR and VAULT_TOKEN set, the server reads one KV v2 document at boot,
  secret/<VAULT_PROJECT>/<VAULT_CONFIG> (default personal/prd), and uses its fields for every
  variable the environment does not already set. Vault is read once; if it cannot be read the
  server refuses to start instead of running half-configured.

  Scenario: The database, bucket and operator token come from Vault
    Given a production deployment that keeps its settings in Vault
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | database     | postgres (schema mockingbird_fleet) |
      | object_store | s3 (spec-bucket/mockingbird-fleet/) |
      | sign_in      | operator-issued tokens              |
    And Vault was read once at "/v1/secret/data/personal/prd"
    And Vault received the configured token in the "X-Vault-Token" header
    And the operator token stored in Vault is accepted by the API
    And no secret from the configuration appears in the startup output

  Scenario: VAULT_PROJECT and VAULT_CONFIG choose the document
    Given a production deployment that keeps its settings in Vault at "acme/staging"
    And the configuration sets:
      | VAULT_PROJECT | acme    |
      | VAULT_CONFIG  | staging |
    When the server process is started
    Then the server is listening
    And Vault was read once at "/v1/secret/data/acme/staging"

  Scenario: A variable set in the environment wins over the same field in Vault
    Given a production deployment that keeps its settings in Vault
    And the Vault document also sets "DATABASE_SCHEMA" to "from_vault"
    And the Vault document also sets "S3_PREFIX" to "from-vault"
    And the configuration sets "DATABASE_SCHEMA" to "from_environment"
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | database     | postgres (schema from_environment) |
      | object_store | s3 (spec-bucket/from-vault/)       |

  Scenario: Settings missing from both Vault and the environment are still reported
    Given a production deployment that keeps its settings in Vault
    But the Vault document does not set "DATABASE_URL"
    When the server process is started
    Then the server refuses to start
    And the startup report says "DATABASE_URL is not set"

  Scenario Outline: Vault refuses the read: <case>
    Given a production deployment that keeps its settings in Vault
    But <condition>
    When the server process is started
    Then the server refuses to start
    And the startup report lists 1 problem
    And the startup report says "Vault read of secret/personal/prd failed with HTTP <status>"
    And the startup report says "<why>"
    And the startup report tells the operator to set "VAULT_ADDR"
    And the startup report tells the operator to set "VAULT_TOKEN"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems
    And no secret from the configuration appears in the startup output

    Examples:
      | case                    | condition                                   | status | why                                                                 |
      | the token is not valid  | Vault does not accept the configured token  | 403    | The token is expired or its policy does not allow reading this path |
      | nothing is stored there | Vault has nothing stored at the path        | 404    | Nothing is stored at this path                                      |

  Scenario: Vault cannot be reached
    Given a production deployment that keeps its settings in Vault
    But VAULT_ADDR points at a port where nothing is listening
    When the server process is started
    Then the server refuses to start
    And the startup report says "could not be reached"
    And the startup report says "Check VAULT_ADDR and that this container can reach it"
    And no secret from the configuration appears in the startup output

  Scenario Outline: Only one of the two Vault variables is set: <given>
    Given a complete production configuration
    And the configuration sets "<given>" to "<value>"
    When the server process is started
    Then the server refuses to start
    And the startup report says "<missing> is not set, but <given> is"
    And the startup report says "Set both, or remove both to read every variable from the environment"
    And no secret from the configuration appears in the startup output

    Examples:
      | given       | value                            | missing     |
      | VAULT_ADDR  | https://vault.example.com        | VAULT_TOKEN |
      | VAULT_TOKEN | hvs.vault-token-0a1b2c3d4e5f6a7b | VAULT_ADDR  |

  Scenario: A sealed Vault is retried until it answers
    Given a production deployment that keeps its settings in Vault
    And Vault is sealed for its first 2 reads
    When the server process is started
    Then the server is listening
    And Vault was read 3 times
