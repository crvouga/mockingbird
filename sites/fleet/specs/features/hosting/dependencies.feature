@hosting @startup
Feature: A broken database or object store is diagnosed before the server reports ready
  Valid-looking settings can still point at something that does not work. Before listening, the
  server connects to PostgreSQL and writes, reads and deletes a probe object in the bucket. When
  either fails it exits with code 78 and names the cause and the variable to change, so a bad
  deploy fails its health check instead of passing it and then failing every request.

  Scenario: The database password is wrong
    Given a complete production configuration
    And the database is a PostgreSQL server that requires the password "correct-horse-7d1f03"
    But DATABASE_URL carries the password "wrong-horse-a94c5e21"
    When the server process is started
    Then the server refuses to start
    And the startup report lists 1 problem
    And the startup report says "PostgreSQL rejected the username or password in DATABASE_URL"
    And the startup report says "Special characters in a password must be percent-encoded"
    And the startup report tells the operator to set "DATABASE_URL"
    And the startup output does not contain "wrong-horse-a94c5e21"
    And the startup output does not contain "correct-horse-7d1f03"

  Scenario: The right database password is accepted
    Given a complete production configuration
    And the database is a PostgreSQL server that requires the password "correct-horse-7d1f03"
    When the server process is started
    Then the server is listening
    And the startup output does not contain "correct-horse-7d1f03"

  Scenario: The database named in the URL does not exist
    Given a complete production configuration
    But DATABASE_URL names the database "fleet_typo"
    When the server process is started
    Then the server refuses to start
    And the startup report says "The database named in DATABASE_URL does not exist"
    And the startup report says "Create the database (createdb <name>), or fix the name at the end of DATABASE_URL"
    And the startup report tells the operator to set "DATABASE_URL"

  Scenario: Nothing is listening where DATABASE_URL points
    Given a complete production configuration
    But DATABASE_URL points at a port where nothing is listening
    When the server process is started
    Then the server refuses to start
    And the startup report says "PostgreSQL did not accept a connection at the host and port in DATABASE_URL"
    And the startup report says "Inside Docker, `localhost` is the container itself: use the database's service name (e.g. postgres) or host.docker.internal"
    And the startup report tells the operator to set "DATABASE_URL"

  Scenario: DATABASE_URL asks for TLS and the database does not offer it
    Given a complete production configuration
    But DATABASE_URL ends with "?sslmode=require"
    When the server process is started
    Then the server refuses to start
    And the startup report says "The TLS handshake with PostgreSQL failed"
    And the startup report says "?sslmode=disable for a local one without TLS"
    And the startup report tells the operator to set "DATABASE_URL"

  Scenario: The bucket does not exist
    Given a complete production configuration
    But the object store has no bucket named "fleet-state-typo"
    And the configuration sets "S3_BUCKET" to "fleet-state-typo"
    When the server process is started
    Then the server refuses to start
    And the startup report says "Bucket "fleet-state-typo" does not exist"
    And the startup report says "The server never creates buckets"
    And the startup report tells the operator to set "S3_BUCKET"

  Scenario: Nothing is listening where S3_ENDPOINT points
    Given a complete production configuration
    But S3_ENDPOINT points at a port where nothing is listening
    When the server process is started
    Then the server refuses to start
    And the startup report says "could not be reached"
    And the startup report says "Inside Docker, `localhost` is the container itself: use the store's service name (e.g. http://minio:9000) or host.docker.internal"
    And the startup report tells the operator to set "S3_ENDPOINT"

  Scenario: The object store denies the access key
    Given a complete production configuration
    And the object store answers every request with "AccessDenied" (403)
    When the server process is started
    Then the server refuses to start
    And the startup report says "The object store denied PUT on bucket"
    And the startup report says "the key may read, write, list and delete objects under "mockingbird-fleet/""
    And the startup report tells the operator to set "S3_ACCESS_KEY_ID"
    And the startup report tells the operator to set "S3_SECRET_ACCESS_KEY"
    And no secret from the configuration appears in the startup output

  Scenario: The object store rejects the request signature
    Given a complete production configuration
    And the object store answers every request with "SignatureDoesNotMatch" (403)
    When the server process is started
    Then the server refuses to start
    And the startup report says "The object store rejected the request signature"
    And the startup report says "S3_SECRET_ACCESS_KEY does not match S3_ACCESS_KEY_ID, or S3_REGION is wrong"
    And the startup report tells the operator to set "S3_SECRET_ACCESS_KEY"
    And the startup report tells the operator to set "S3_REGION"
    And no secret from the configuration appears in the startup output

  Scenario: S3_ENDPOINT is not an S3 API
    Given a complete production configuration
    And the object store answers every request with "InternalError" (500)
    When the server process is started
    Then the server refuses to start
    And the startup report says "The object store answered PUT with HTTP 500"
    And the startup report tells the operator to set "S3_ENDPOINT"

  Scenario: A broken database and a broken bucket are reported together
    Given a complete production configuration
    But DATABASE_URL names the database "fleet_typo"
    And the object store has no bucket named "fleet-state-typo"
    And the configuration sets "S3_BUCKET" to "fleet-state-typo"
    When the server process is started
    Then the server refuses to start
    And the startup report lists 2 problems
    And the startup report says "The database named in DATABASE_URL does not exist"
    And the startup report says "Bucket "fleet-state-typo" does not exist"
    And every problem in the startup report says why it matters, how to fix it and what to set
    And the startup output ends with one JSON line listing the same problems

  Scenario: The startup probe leaves nothing behind in the bucket
    Given a complete production configuration
    And the object store is a bucket of its own
    When the server process is started
    Then the server is listening
    And the bucket holds no objects under "mockingbird-fleet/preflight/"
