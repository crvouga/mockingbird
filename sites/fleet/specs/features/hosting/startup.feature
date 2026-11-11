@hosting @startup
Feature: Starting and stopping the server
  One stateless image, any number of replicas. A start says what it connected to, replicas may
  start together against an empty database, the service keeps to its own schema, and a stop
  signal ends the process cleanly after saving what was still in memory.

  Scenario: A successful start says what it is connected to
    Given a complete production configuration
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | public_url   | https://fleet.example.com           |
      | fleet_url    | https://fleet.example.com           |
      | database     | postgres (schema mockingbird_fleet) |
      | object_store | s3 (spec-bucket/mockingbird-fleet/) |
      | sign_in      | operator-issued tokens              |
      | telemetry    | stdout                              |
    And the server answers "/health" with status 200
    And the server answers "/ready" with status 200
    And no secret from the configuration appears in the startup output

  Scenario: The listening line names every configured way to sign in
    Given a local configuration with a database, a bucket, dev login and an operator token
    And the configuration sets:
      | OIDC_ISSUER    | https://id.example.com |
      | OIDC_CLIENT_ID | fleet-dashboard        |
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | sign_in | oidc, operator-issued tokens, dev login |

  Scenario: The object-store prefix and a separate fleet address show in the listening line
    Given a complete production configuration
    And the configuration sets:
      | S3_PREFIX | /tenants/fleet-a/          |
      | FLEET_URL | https://fleets.example.com |
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | fleet_url    | https://fleets.example.com          |
      | object_store | s3 (spec-bucket/tenants/fleet-a/)   |

  Scenario: Without PUBLIC_URL the server assumes localhost on its port
    Given a local configuration with only dev login turned on
    When the server process is started
    Then the server is listening
    And the "listening" line gives the public address as localhost on the configured port

  Scenario: A public deployment that trusts no proxy is warned about shared rate limits
    Given a complete production configuration
    When the server process is started
    Then the server is listening
    And the server log warns "TRUSTED_PROXY_HOPS is 0"
    And the server log warns "Set TRUSTED_PROXY_HOPS to the number of proxies in front of it (usually 1)"

  Scenario: The proxy warning goes away once TRUSTED_PROXY_HOPS is set
    Given a complete production configuration
    And the configuration sets "TRUSTED_PROXY_HOPS" to "1"
    When the server process is started
    Then the server is listening
    And the server log has no warnings

  Scenario: On localhost there is no proxy warning
    Given a local configuration with a database, a bucket, dev login and an operator token
    When the server process is started
    Then the server is listening
    And the server log has no warnings

  Scenario: Two replicas starting together against an empty database both come up
    Given a complete production configuration
    And the database is a new, empty PostgreSQL database
    When two server processes are started at the same moment
    Then both servers are listening
    And both servers answer "/ready" with status 200
    And the database records each schema version exactly once

  Scenario: A replica joining later changes nothing in the database
    Given a complete production configuration
    And the database is a new, empty PostgreSQL database
    And the server process is started
    When another server process is started against the same database
    Then both servers are listening
    And the database records each schema version exactly once

  Scenario: Every table lives in the configured schema
    Given a complete production configuration
    And the database is a new, empty PostgreSQL database
    And the configuration sets "DATABASE_SCHEMA" to "fleet_prod"
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | database | postgres (schema fleet_prod) |
    And the database has the tables "users, sessions, orgs, projects, fleets, api_keys" in schema "fleet_prod"
    And the database has no tables outside schema "fleet_prod"

  Scenario: The default schema is mockingbird_fleet
    Given a complete production configuration
    And the database is a new, empty PostgreSQL database
    When the server process is started
    Then the server is listening
    And the database has no tables outside schema "mockingbird_fleet"

  Scenario Outline: <signal> stops the server cleanly
    Given a complete production configuration
    And the server process is started
    When the server process receives <signal>
    Then the server process exits with code 0
    And the server log has a "shutting down" line with:
      | signal | <signal> |
    And nothing is listening on the configured port any more

    Examples:
      | signal  |
      | SIGTERM |
      | SIGINT  |

  Scenario: Emulator state still in memory is saved before the process exits
    Given a server whose hosted emulator has accepted a write it has not saved yet
    When that server receives SIGTERM
    Then that server exits with code 0
    And after the server starts again the emulator still has that write
