@hosting @startup
Feature: The check command validates a deployment without starting it
  `bun dist/main.js check` runs the same validation as a real start (the variables, the
  database, the bucket) and then exits, so an operator can test a configuration in CI or in a
  one-off container before any traffic depends on it.

  Scenario: A valid configuration passes
    Given a complete production configuration
    When the operator runs the check command
    Then the check exits with code 0
    And the check prints "mockingbird-fleet configuration is valid; the database and object store work."
    And the check prints a "check_passed" JSON line with:
      | public_url   | https://fleet.example.com            |
      | database     | postgres (schema mockingbird_fleet)  |
      | object_store | s3 (spec-bucket/mockingbird-fleet/)  |
      | telemetry    | stdout                               |
    And the check never listened on the configured port
    And no secret from the configuration appears in the startup output

  Scenario: An invalid configuration fails with the same report a start would print
    Given a complete production configuration
    But the configuration leaves out "DATABASE_URL"
    When the operator runs the check command
    Then the check exits with code 78
    And the startup report says "DATABASE_URL is not set"
    And the startup report tells the operator to set "DATABASE_URL"
    And the startup output ends with one JSON line listing the same problems
    And the check never listened on the configured port

  Scenario: A dependency that does not work fails the check
    Given a complete production configuration
    But the object store has no bucket named "fleet-state-typo"
    And the configuration sets "S3_BUCKET" to "fleet-state-typo"
    When the operator runs the check command
    Then the check exits with code 78
    And the startup report says "Bucket "fleet-state-typo" does not exist"
    And the check never listened on the configured port

  Scenario: On localhost the check passes with in-memory storage
    Given a local configuration with only dev login turned on
    When the operator runs the check command
    Then the check exits with code 0
    And the check prints a "check_passed" JSON line with:
      | database     | memory |
      | object_store | memory |

  Scenario: Vault is consulted by the check as well
    Given a production deployment that keeps its settings in Vault
    When the operator runs the check command
    Then the check exits with code 0
    And Vault was read once at "/v1/secret/data/personal/prd"
