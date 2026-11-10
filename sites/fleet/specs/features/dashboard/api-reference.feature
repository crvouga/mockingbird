@dashboard
Feature: The API reference in the dashboard
  Everything the dashboard does is an API call, and the dashboard lists them all, read from the
  server's own OpenAPI document.

  Background:
    Given Ada is signed in to the dashboard

  Scenario: The reference is one click away
    When they open the dashboard
    And they follow "API"
    Then they see the page "API reference"
    And the address is "/api-reference"

  Scenario: It says where the API lives and where its contract is
    When they open the dashboard at "/api-reference"
    Then the server's API address is on screen with a "Copy base URL" button
    And the address of the OpenAPI document is on screen with a "Copy OpenAPI URL" button

  Scenario: It lists every operation of the OpenAPI document
    When they open the dashboard at "/api-reference"
    Then every operation of the OpenAPI document is listed with its method, path and summary

  Scenario: Operations are grouped the way the OpenAPI document tags them
    When they open the dashboard at "/api-reference"
    Then there is a section for every tag of the OpenAPI document
