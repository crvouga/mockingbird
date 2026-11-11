@hosting @startup
Feature: A misconfigured server refuses to start and says how to fix it
  The image is configured only by environment variables. An operator (or an agent reading the
  boot log) who gets one wrong must learn everything that is wrong in a single run: the process
  exits with code 78 before it ever listens, prints a numbered report where each problem says
  why it matters, how to fix it and which variable to set, and ends with the same problems as
  one JSON line for tools.

  Scenario: Only the public address is configured
    Given a production deployment with nothing configured but its public address
    When the server process is started
    Then the server refuses to start
    And the startup report lists 3 problems
    And the startup report says "DATABASE_URL is not set"
    And the startup report says "S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET are not set"
    And the startup report says "No way to sign in is configured"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems

  Scenario Outline: A required setting is missing: <left out>
    Given a complete production configuration
    But the configuration leaves out "<left out>"
    When the server process is started
    Then the server refuses to start
    And the startup report says "<problem>"
    And the startup report tells the operator to set "<set>"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems

    Examples: the database
      | left out     | problem                 | set          |
      | DATABASE_URL | DATABASE_URL is not set | DATABASE_URL |

    Examples: the object store needs all five variables together
      | left out                                                           | problem                                                                                  | set                  |
      | S3_BUCKET                                                          | S3_BUCKET is not set                                                                     | S3_BUCKET            |
      | S3_REGION, S3_SECRET_ACCESS_KEY                                    | S3_REGION, S3_SECRET_ACCESS_KEY are not set                                              | S3_SECRET_ACCESS_KEY |
      | S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY     | All five are needed together                                                             | S3_ENDPOINT          |
      | S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET | S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET are not set | S3_BUCKET            |

    Examples: a way to sign in
      | left out       | problem                         | set            |
      | OPERATOR_TOKEN | No way to sign in is configured | OPERATOR_TOKEN |

  Scenario Outline: A setting has a value that cannot be used: <variable>=<value>
    Given a complete production configuration
    But the configuration sets "<variable>" to "<value>"
    When the server process is started
    Then the server refuses to start
    And the startup report says "<problem>"
    And the startup report tells the operator to set "<variable>"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems
    And no secret from the configuration appears in the startup output

    Examples: addresses
      | variable     | value                                         | problem                                                                            |
      | PORT         | eighty                                        | PORT is invalid: it must be a whole number of at least 1                           |
      | PORT         | 0                                             | PORT is invalid: it must be a whole number of at least 1                           |
      | PUBLIC_URL   | http://fleet.example.com                      | PUBLIC_URL is invalid: it must be an absolute https URL                            |
      | PUBLIC_URL   | fleet.example.com                             | PUBLIC_URL is invalid: it must be an absolute https URL                            |
      | FLEET_URL    | http://fleets.example.com                     | FLEET_URL is invalid: it must be an absolute https URL                             |
      | CORS_ORIGINS | https://app.example.com/dashboard             | "https://app.example.com/dashboard" is not an origin                               |
      | CORS_ORIGINS | https://app.example.com,*                     | "*" is not an origin                                                               |

    Examples: storage
      | variable        | value                                              | problem                                                                       |
      | DATABASE_URL    | mysql://fleet:db-password-4b1d77e0@db.internal/app | DATABASE_URL is invalid: it must be a postgres:// URL                         |
      | DATABASE_URL    | postgres://fleet:db/pass#4b1d77e0@db.internal/app  | DATABASE_URL is invalid: it must be a postgres:// URL                         |
      | DATABASE_SCHEMA | Fleet-Prod                                         | DATABASE_SCHEMA is invalid: it must be a lowercase PostgreSQL identifier      |
      | DATABASE_SCHEMA | fleet;drop                                         | DATABASE_SCHEMA is invalid: it must be a lowercase PostgreSQL identifier      |
      | S3_PREFIX       | ../other-tenant                                    | S3_PREFIX is invalid: it must be a non-empty key prefix                       |
      | S3_PREFIX       | /                                                  | S3_PREFIX is invalid: it must be a non-empty key prefix                       |
      | S3_ENDPOINT     | https://AKIAEXAMPLE:embedded-secret-9c2e41@s3.example.com | S3_ENDPOINT is invalid: it must be an absolute URL without embedded credentials |
      | S3_ENDPOINT     | s3.example.com                                     | S3_ENDPOINT is invalid: it must be an absolute URL without embedded credentials |

    Examples: sign-in
      | variable       | value                        | problem                                                            |
      | OPERATOR_TOKEN | only-twenty-chars-xx         | OPERATOR_TOKEN is invalid: it must be at least 32 characters       |
      | AUTH_DEV_LOGIN | 1                            | AUTH_DEV_LOGIN=1 is set on a non-loopback PUBLIC_URL               |

    Examples: limits and tuning
      | variable                   | value | problem                                                                     |
      | LIMIT_FLEETS_PER_ORG       | -1    | LIMIT_FLEETS_PER_ORG is invalid: it must be a whole number of at least 0    |
      | LIMIT_STATE_BYTES          | 1.5   | LIMIT_STATE_BYTES is invalid: it must be a whole number of at least 0       |
      | LIMIT_REQUESTS_PER_MONTH   | lots  | LIMIT_REQUESTS_PER_MONTH is invalid: it must be a whole number of at least 0 |
      | LIMIT_ORGS_PER_USER        | -5    | LIMIT_ORGS_PER_USER is invalid: it must be a whole number of at least 0     |
      | RATE_LIMIT_API_PER_MINUTE  | fast  | RATE_LIMIT_API_PER_MINUTE is invalid: it must be a whole number of at least 0 |
      | TRUSTED_PROXY_HOPS         | -1    | TRUSTED_PROXY_HOPS is invalid: it must be a whole number of at least 0      |
      | FLEET_MAX_INSTANCES        | 0     | FLEET_MAX_INSTANCES is invalid: it must be a whole number of at least 1     |
      | FLEET_REQUEST_TIMEOUT_MS   | 5     | FLEET_REQUEST_TIMEOUT_MS is invalid: it must be a whole number of at least 100 |

    Examples: telemetry
      | variable                   | value                        | problem                                                                |
      | OTEL_EXPORTER_OTLP_HEADERS | authorization=Bearer%ZZtoken | OTEL_EXPORTER_OTLP_HEADERS is invalid: it must be name=value pairs     |
      | OTEL_EXPORTER_OTLP_ENDPOINT | collector.internal:4318    | OTEL_EXPORTER_OTLP_ENDPOINT is invalid: it must be an absolute http(s) URL |

  Scenario Outline: OpenID Connect sign-in needs both of its variables: only <given>
    Given a complete production configuration
    But the configuration sets "<given>" to "<value>"
    When the server process is started
    Then the server refuses to start
    And the startup report says "<missing> is not set, but <given> is"
    And the startup report tells the operator to set "OIDC_ISSUER"
    And the startup report tells the operator to set "OIDC_CLIENT_ID"

    Examples:
      | given          | value                  | missing        |
      | OIDC_ISSUER    | https://id.example.com | OIDC_CLIENT_ID |
      | OIDC_CLIENT_ID | fleet-dashboard        | OIDC_ISSUER    |

  Scenario: Every problem is reported in one run, not one per restart
    Given a complete production configuration
    But the configuration leaves out "DATABASE_URL, S3_BUCKET"
    And the configuration sets:
      | PORT                 | eighty                            |
      | OPERATOR_TOKEN       | only-twenty-chars-xx              |
      | AUTH_DEV_LOGIN       | 1                                 |
      | OIDC_ISSUER          | https://id.example.com            |
      | CORS_ORIGINS         | https://app.example.com/dashboard |
      | S3_PREFIX            | ../other-tenant                   |
      | DATABASE_SCHEMA      | Fleet-Prod                        |
      | LIMIT_FLEETS_PER_ORG | -1                                |
    When the server process is started
    Then the server refuses to start
    And the startup report lists 10 problems
    And the startup report says "PORT is invalid"
    And the startup report says "DATABASE_SCHEMA is invalid"
    And the startup report says "DATABASE_URL is not set"
    And the startup report says "S3_BUCKET is not set"
    And the startup report says "S3_PREFIX is invalid"
    And the startup report says "OIDC_CLIENT_ID is not set, but OIDC_ISSUER is"
    And the startup report says "AUTH_DEV_LOGIN=1 is set on a non-loopback PUBLIC_URL"
    And the startup report says "OPERATOR_TOKEN is invalid"
    And the startup report says "CORS_ORIGINS is invalid"
    And the startup report says "LIMIT_FLEETS_PER_ORG is invalid"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems

  Scenario: The report explains how to check again and where the reference is
    Given a production deployment with nothing configured but its public address
    When the server process is started
    Then the server refuses to start
    And the startup report says "mockingbird-fleet cannot start: 3 problems to fix"
    And the startup report says "Re-check without starting the server:  bun dist/main.js check"
    And the startup report says "Variables are read from the process environment only"
    And the startup output contains no stack trace

  Scenario: Secrets given in the environment never reach the output
    Given a complete production configuration
    But the configuration sets:
      | DATABASE_URL         | postgres://fleet:db/password#4b1d77e0@db.internal/app    |
      | S3_ENDPOINT          | https://AKIAEXAMPLE:embedded-secret-9c2e41@s3.example.com |
      | S3_SECRET_ACCESS_KEY | s3-secret-5d0e8a13b7c94f62                               |
      | OPERATOR_TOKEN       | only-twenty-chars-xx                                     |
    When the server process is started
    Then the server refuses to start
    And the startup report lists 3 problems
    And the startup output does not contain "db/password#4b1d77e0"
    And the startup output does not contain "embedded-secret-9c2e41"
    And the startup output does not contain "s3-secret-5d0e8a13b7c94f62"
    And the startup output does not contain "only-twenty-chars-xx"
    And the startup output contains no stack trace

  Scenario: The port is already taken
    Given a complete production configuration
    And another program is already listening on the configured port
    When the server process is started
    Then the server refuses to start
    And the startup report says "Could not listen on port"
    And the startup report tells the operator to set "PORT"

  Scenario: On localhost the server starts with no database and no bucket, and says so
    Given a local configuration with only dev login turned on
    When the server process is started
    Then the server is listening
    And the server log has a "listening" line with:
      | database     | memory    |
      | object_store | memory    |
      | sign_in      | dev login |
    And the server log warns "running with in-memory storage: nothing survives a restart"

  Scenario: On localhost a partly configured object store is still refused
    Given a local configuration with only dev login turned on
    And the configuration sets "S3_BUCKET" to "fleet-state"
    When the server process is started
    Then the server refuses to start
    And the startup report says "S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are not set"

  Scenario: Even on localhost some way to sign in is required
    Given a local configuration with nothing set
    When the server process is started
    Then the server refuses to start
    And the startup report says "No way to sign in is configured"
