@dashboard
Feature: The dashboard is a client of the API and nothing else
  Whatever a person does in the dashboard, an agent can do with the same API calls. The page
  ships as three files and talks only to the control API, the OpenAPI document and the sign-in
  endpoints of the server it came from.

  Scenario: A tour of every screen asks the server for nothing but its files, the API and sign-in
    Given a visitor who is not signed in
    When they open the dashboard
    And they sign in locally as Ada
    And they type "Acme" into "Organization name"
    And they press "Create organization"
    And they type "Web app" into "Project name"
    And they press "Create project"
    And they type "Staging" into "Fleet name"
    And they press "Create fleet"
    And they type "resend" into "Search emulators"
    And they add "Resend" from the catalog
    And they press "Save now"
    And they follow "Web app"
    And they follow "Acme"
    And they follow "Members"
    And they follow "Usage"
    And they follow "API keys"
    And they type "ci" into "Key name"
    And they press "Create key"
    And they follow "Audit log"
    And they follow "Settings"
    And they follow "Account"
    And they follow "API"
    And they press "Sign out"
    Then they are asked to sign in
    And the page consisted of the files "/, /app.css, /app.js"
    And every other request went to "/api/v1/, /api/openapi.json, /auth/"
    And nothing was requested from another origin

  Scenario: The page is served under a policy that allows no inline scripts or styles
    Given a visitor who is not signed in
    When they open the dashboard
    Then the page's content security policy only allows resources from the server itself

  Scenario Outline: The <screen> screen carries no inline scripts or styles
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app" running:
      | name   | emulator | durability |
      | resend | resend   | buffered   |
    When they open the <screen>
    Then the page has no inline scripts or styles
    And the browser reported no blocked resources

    Examples:
      | screen                       |
      | organization "Acme"          |
      | "Members" tab of "Acme"      |
      | "Usage" tab of "Acme"        |
      | project "Web app"            |
      | fleet "Staging"              |
      | dashboard at "/account"      |
      | dashboard at "/api-reference"|
