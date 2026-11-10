@dashboard
Feature: Usage and limits in the dashboard
  The Usage tab shows what the operator allows an organization, how much of it is used, and how
  many emulator requests arrived each day.

  Scenario: Limits are shown beside what the organization has used
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app"
    When they open the "Usage" tab of "Acme"
    Then they see "Limits are set by the operator of this server. Requests are counted per calendar month (UTC)."
    And the limit "Projects" reads "1 of 20"
    And the limit "Fleets" reads "1 of 50"
    And the limit "Members and pending invites" reads "1 of 50"
    And the limit "API keys" reads "0 of 50"
    And the limit "Emulator requests this month" reads "0 of 1,000,000"
    And the limit "Emulators per fleet" reads "up to 50"
    And the limit "Requests per fleet per minute" reads "up to 3,000"

  Scenario: An organization that has received no requests says so
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    When they open the "Usage" tab of "Acme"
    Then they see "No emulator requests in the last 31 days."

  Scenario: Requests to an emulator are counted for the day they arrived
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app" with a "resend" emulator named "resend"
    And 3 emails have been sent through the "resend" emulator of "Staging"
    When they open the "Usage" tab of "Acme"
    Then the limit "Emulator requests this month" reads "3 of 1,000,000"
    And today is listed under requests per day with "3"

  Scenario: A limit that has been reached is marked, and going past it is refused
    Given the server is configured with:
      | LIMIT_PROJECTS_PER_ORG   | 1 |
      | LIMIT_REQUESTS_PER_MONTH | 0 |
    And Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    When they open the "Usage" tab of "Acme"
    Then the limit "Projects" reads "1 of 1"
    And the limit "Projects" is marked as reached
    And the limit "Fleets" is not marked as reached
    And the limit "Emulator requests this month" reads "0 of unlimited"
    When they follow "Projects"
    And they type "Second" into "Project name"
    And they press "Create project"
    Then they see the error "limit 1"
