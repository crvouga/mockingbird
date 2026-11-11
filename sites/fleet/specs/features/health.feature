Feature: Liveness and readiness
  A platform probes the service to decide whether a deploy is healthy.

  Scenario: Health answers without credentials or dependencies
    When anyone requests "/health"
    Then the response status is 200

  Scenario: Readiness confirms the database is reachable
    When anyone requests "/ready"
    Then the response status is 200
