@hosting @observability
Feature: Traces, metrics and logs
  With OTEL_EXPORTER_OTLP_ENDPOINT set, the server exports traces, metrics and logs to that
  collector over OTLP/HTTP and continues the trace of whoever called it. Telemetry is never
  allowed to fail a request, and without a collector the server simply writes structured logs.

  Scenario: An API call is traced as part of the caller's trace
    Given a server that exports telemetry to a collector
    When the operator calls the API inside the trace "0af7651916cd43dd8448eb211c80319c" from span "b7ad6b7169203331"
    Then the collector receives a server span "POST /api/*" in that trace whose parent is the caller's span
    And that span records the request method, the path, a request id and the status 201
    And the collector receives a span "api adminCreateUser" inside that server span

  Scenario: A call to a hosted emulator is traced down to the emulator
    Given a server that exports telemetry to a collector
    And a fleet with a "resend" emulator on that server
    When a client calls the emulator inside the trace "1bf7651916cd43dd8448eb211c80319c" from span "c7ad6b7169203331"
    Then the collector receives a server span "GET /f/*" in that trace whose parent is the caller's span
    And the collector receives a span "fleet.request" inside that server span
    And that span names the emulator "resend"

  Scenario: A call without trace context starts a trace of its own
    Given a server that exports telemetry to a collector
    When the operator calls the API with no trace context
    Then the collector receives a server span "POST /api/*" with no parent

  Scenario: A malformed traceparent is ignored rather than trusted
    Given a server that exports telemetry to a collector
    When the operator calls the API with the traceparent "not-a-trace-context"
    Then the collector receives a server span "POST /api/*" with no parent

  Scenario: Metrics and logs arrive at the collector too
    Given a server that exports telemetry to a collector
    When the operator calls the API with no trace context
    Then the collector receives a metrics export
    And the collector receives an "INFO" log record from the service "mockingbird-fleet"

  Scenario: OTEL_SERVICE_NAME names the service
    Given a server that exports telemetry to a collector as the service "fleet-staging"
    When the operator calls the API with no trace context
    Then every span at the collector comes from the service "fleet-staging"

  Scenario: OTEL_EXPORTER_OTLP_HEADERS authenticates the export
    Given a collector that only accepts the bearer token "otlp-ingest-token-51c0e7a9"
    And a server that exports telemetry to that collector with the header "authorization=Bearer%20otlp-ingest-token-51c0e7a9"
    When the operator calls the API with no trace context
    Then the collector receives a server span "POST /api/*" with no parent
    And the server output does not contain "otlp-ingest-token-51c0e7a9"

  Scenario: Telemetry still buffered is sent before the process exits
    Given a server that exports telemetry to a collector
    When the operator calls the API inside the trace "2cf7651916cd43dd8448eb211c80319c" from span "d7ad6b7169203331"
    And the exporting server is stopped right away
    Then the exporting server exited with code 0
    And the collector already holds a span of the trace "2cf7651916cd43dd8448eb211c80319c"

  Scenario: An unreachable collector does not fail requests
    Given a server that exports telemetry to a collector that is not running
    When the operator calls the API with no trace context
    Then the response status is 201
    And the exporting server keeps answering "/ready" after an export interval has passed
    And the exporting server stops cleanly

  Scenario: A collector that answers with errors does not fail requests
    Given a server that exports telemetry to a collector
    And the collector starts answering every export with 503
    When the operator calls the API with no trace context
    Then the response status is 201
    And the collector has refused at least one export
    And the exporting server keeps answering "/ready" after an export interval has passed

  Scenario: Without a collector nothing is exported and logs are structured lines on stdout
    Given a server with no OTEL_EXPORTER_OTLP_ENDPOINT
    When the operator calls the API with no trace context
    Then the response status is 201
    And every line the server wrote is a JSON object with a time, a level and a message
    And the server log has a "listening" line with:
      | telemetry | stdout |
    And no collector has received anything from that server

  Scenario: Credentials never appear in logs or exported telemetry
    Given a server that exports telemetry to a collector
    When people sign in and call the API with an operator token, a personal token, a session and a rejected token
    And the exporting server is stopped right away
    Then none of those credentials appear in the server output
    And none of those credentials appear in what the collector received
