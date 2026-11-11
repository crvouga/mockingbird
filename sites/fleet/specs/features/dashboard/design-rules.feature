@dashboard
Feature: The dashboard's design rules
  Every screen of the dashboard is one of two kinds. A query shows things and links to other
  screens; it has no form and nothing on it changes anything. A mutation is one form with one
  button and a Cancel link, at an address of its own. Feedback stays where it belongs: a problem
  with a field is written under that field, a problem with the whole request is summarised at the
  top of the form, and a change that worked is noted beside the thing it changed on the screen the
  dashboard goes to next. Nothing pops up, floats or announces itself anywhere else.

  Rule: Every screen is a query or a mutation, and keeps to its kind

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      And Grace has joined "Acme" with the member role
      And Ada has invited Linus to "Acme" as a viewer
      And Ada has an organization key "ci" for "Acme" with the member role
      And Ada has a personal token "laptop"

    Scenario: Every screen an owner can reach keeps the design rules
      When they open every screen of the dashboard in turn
      Then each one is drawn as the kind of screen its route declares
      And none of them breaks a design rule

    Scenario: Every form keeps the design rules while it points out problems
      When they send every form of the dashboard without filling it in properly
      Then each one points out at least one problem, in the form
      And each one moves the focus to the first problem
      And none of them breaks a design rule

    Scenario Outline: The screen that shows <secret> once keeps the design rules
      When they open the address of the organization "Acme" followed by "<form>"
      And they fill in "<field>" with "<value>" and send the form
      Then they see the page "<page>"
      And the screen keeps the design rules

      Examples:
        | secret             | form          | field | value                      | page                |
        | a new API key      | /keys/new     | Name  | deploy                     | API key created     |
        | a new invite link  | /invites/new  | Email | hedy@example.test          | Invite link created |

    Scenario: The screen that shows a new personal token once keeps the design rules
      When they open the dashboard at "/account/tokens/new"
      And they fill in "Name" with "agent" and send the form
      Then they see the page "Personal token created"
      And the screen keeps the design rules

  Rule: A screen drawn in place of another keeps the design rules too

    Scenario: An address that names nothing
      Given Ada is signed in to the dashboard
      When they open the dashboard at "/no-such-page"
      Then the screen is the "not-found" state
      And the screen keeps the design rules

    Scenario: Something that does not exist
      Given Ada is signed in to the dashboard
      When they open the dashboard at "/fleets/flt_nope/delete"
      Then the screen is the "not-found" state
      And the screen keeps the design rules

    Scenario: A screen the role may not open
      Given Ada owns an organization "Acme"
      And Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the "Settings" tab of "Acme"
      Then the screen is the "forbidden" state
      And the screen keeps the design rules

    Scenario: A secret asked for a second time
      Given Ada is signed in to the dashboard
      When they open the dashboard at "/account/tokens/tok_nope/created"
      Then the screen is the "gone" state
      And the screen keeps the design rules

    Scenario: A screen the server refused to fill
      Given the server is configured with:
        | RATE_LIMIT_API_PER_MINUTE | 3 |
      And Ada is signed in to the dashboard
      When they open the dashboard at "/account"
      And they reload the page
      Then the screen is the "error" state
      And they see "Too many API requests."
      And there is a link "Try again"
      And the screen keeps the design rules

    Scenario: A server that does not answer
      Given a deployment of its own for this scenario
      And Ada is signed in to the dashboard
      When they open the dashboard at "/account"
      And the server stops
      And they follow "API"
      Then the screen is the "unavailable" state
      And the screen keeps the design rules

  Rule: Feedback stays in the screen it is about; nothing pops up or floats

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"

    Scenario: A change that works is noted on the screen it lands on, and nowhere else
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Web app" into "Name"
      And they press "Create project"
      Then they see the note "Created just now"
      And nothing on the page announces itself outside the screen

    Scenario: A problem with a field is written in the form, and nowhere else
      When they open the dashboard at "/orgs/new"
      And they press "Create organization"
      Then the field "Name" says "Enter a name for the organization."
      And nothing on the page announces itself outside the screen
      And the screen keeps the design rules

    Scenario: A refused request is summarised in the form, and nowhere else
      Given the operator has suspended "Acme" for "unpaid invoice"
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Web app" into "Name"
      And they press "Create project"
      Then the form says "The project was not created."
      And nothing on the page announces itself outside the screen
      And the screen keeps the design rules

    Scenario: While a change is being sent, the form says so and cannot be sent twice
      Given the server holds every change until it is told to answer
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Web app" into "Name"
      And they press "Create project" without waiting
      Then the form is busy
      And the button "Creating…" is disabled
      And nothing on the page announces itself outside the screen
      When they press Enter in "Name"
      And the server answers
      Then they see the page "Web app"
      And they see the note "Created just now"
      And only one project was created in "Acme"

  Rule: The focus goes where the person needs to look

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"

    Scenario: Moving to another screen puts the focus on its heading
      When they open the organization "Acme"
      And they follow "New project"
      Then the page heading has the focus
      When they cancel
      Then they see the page "Acme"
      And the page heading has the focus

    Scenario: A change that works puts the focus on the heading of the screen it lands on
      When they open the dashboard at "/orgs/new"
      And they type "Globex" into "Name"
      And they press "Create organization"
      Then they see the page "Globex"
      And the page heading has the focus

    Scenario: A form sent with a problem puts the focus on the field
      When they open the dashboard at "/orgs/new"
      And they press "Create organization"
      Then the field "Name" has the focus

    Scenario: A form sent with several problems puts the focus on the first of them
      Given Ada has a project "Web app" in "Acme"
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they choose "Project: Web app" as the "Scope"
      And they choose "Admin" as the "Role"
      And they press "Create API key"
      Then exactly 2 problems are pointed out
      And the field "Name" has the focus

    Scenario: A refused request puts the focus on the form's summary
      Given the operator has suspended "Acme" for "unpaid invoice"
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Web app" into "Name"
      And they press "Create project"
      Then the form's summary has the focus
