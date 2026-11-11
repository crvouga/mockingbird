@dashboard
Feature: Usage and limits in the dashboard
  The Usage tab shows what the operator allows an organization, how much of it is used, and how
  many emulator requests arrived each day. When a limit is reached, the form that would go past
  it says so, in the form, and creates nothing.

  Rule: The Usage tab shows limits and requests

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"

    Scenario: Limits are shown beside what the organization has used
      Given Ada has a project "Web app" in "Acme"
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
      When they open the "Usage" tab of "Acme"
      Then they see "No emulator requests in the last 31 days."

    Scenario: Requests to an emulator are counted for the day they arrived
      Given Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app" with a "resend" emulator named "resend"
      And 3 emails have been sent through the "resend" emulator of "Staging"
      When they open the "Usage" tab of "Acme"
      Then the limit "Emulator requests this month" reads "3 of 1,000,000"
      And today is listed under requests per day with "3"

  Rule: A limit that has been reached is marked, and the form that would pass it says so

    Scenario: A reached limit is marked, and an unlimited one says so
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

    Scenario: A project past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_PROJECTS_PER_ORG | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has a project "Web app" in "Acme"
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Second" into "Name"
      And they press "Create project"
      Then the form says "The project was not created."
      And the form says "(limit 1)"
      And no field is marked wrong
      When they cancel
      Then they see the page "Acme"
      And the project "Second" is not listed

    Scenario: A fleet past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_FLEETS_PER_ORG | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app"
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Preview" into "Name"
      And they press "Create fleet"
      Then the form says "The fleet was not created."
      And the form says "(limit 1)"
      And no field is marked wrong

    Scenario: An emulator past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_EMULATORS_PER_FLEET | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app" with a "stripe" emulator named "stripe"
      When they open the address of the fleet "Staging" followed by "/add-emulator/resend"
      And they press "Add emulator"
      Then the form says "The emulator was not added."
      And the form says "(limit 1)"

    Scenario: An API key past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_API_KEYS_PER_ORG | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has an organization key "ci" for "Acme" with the member role
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "deploy" into "Name"
      And they press "Create API key"
      Then the form says "The API key was not created."
      And the form says "(limit 1)"
      And no secret is shown

    Scenario: An invite past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_MEMBERS_PER_ORG | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      And they type the email of Linus into "Email"
      And they press "Create invite link"
      Then the form says "The invite was not created."
      And the form says "(limit 1)"

    Scenario: An organization past the limit is refused in the form
      Given the server is configured with:
        | LIMIT_ORGS_PER_USER | 1 |
      And Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      When they open the dashboard at "/orgs/new"
      And they type "Globex" into "Name"
      And they press "Create organization"
      Then the form says "The organization was not created."
      And the form says "(limit 1)"
