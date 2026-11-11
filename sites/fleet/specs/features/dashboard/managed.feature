@dashboard
Feature: An organization managed by mockingbird.yaml is read-only in the dashboard
  Once a mockingbird.yaml has been applied to an organization, the file is the only way to
  change what it declares: the organization's name, its projects, its fleets and their
  emulators. The dashboard shows all of it, says on each screen that the file controls it, and
  offers no link to change it. What the file does not declare stays where it was: an emulator's
  state, members, invites, API keys, usage, the audit log, leaving and deleting the organization.

  Background:
    Given Ada has applied this mockingbird.yaml:
      """
      version: 1
      organization: <acme>
      name: Acme
      projects:
        web:
          name: Web app
          fleets:
            <acme-staging>:
              name: Staging
              access: open
              services:
                resend: {}
                billing: { target: stripe, durability: strict }
      """
    And Ada is signed in to the dashboard

  Rule: Every screen that shows what the file declares says so

    Scenario Outline: <screen> says it is configured by mockingbird.yaml
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then the screen says it is configured by mockingbird.yaml, last applied by Ada
      And the screen says "<read-only>" beside that
      And the screen keeps the design rules

      Examples:
        | screen                      | kind         | name    | rest      | read-only                                                                                                |
        | The organization's projects | organization | Acme    |           | This organization's projects, fleets and emulators are declared in the file, so they are read-only here. |
        | The organization's settings | organization | Acme    | /settings | The organization's name is declared in the file, so it is read-only here.                                |
        | A project                   | project      | Web app |           | This project and its fleets are declared in the file, so they are read-only here.                        |
        | A fleet                     | fleet        | Staging |           | This fleet and its emulators are declared in the file, so they are read-only here.                       |

    Scenario Outline: From <screen>, "How to change it" opens the Configuration tab
      When they open the address of the <kind> "<name>" followed by ""
      And they follow "How to change it"
      Then the "Configuration" tab is the current one
      And the address is that of the "Configuration" tab of "Acme"

      Examples:
        | screen           | kind         | name    |
        | the organization | organization | Acme    |
        | a project        | project      | Web app |
        | a fleet          | fleet        | Staging |

    Scenario Outline: The <tab> tab, which shows nothing the file declares, does not mention it
      When they open the "<tab>" tab of "Acme"
      Then the screen does not say it is configured by mockingbird.yaml

      Examples:
        | tab       |
        | Members   |
        | Usage     |
        | API keys  |
        | Audit log |

    Scenario: A viewer is told the fleet is read-only, without the offer to operate it
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      Then the screen says it is configured by mockingbird.yaml, last applied by Ada
      And they do not see "You can still save, reset and download emulator state."

  Rule: Nothing the file declares can be changed from the screens that show it

    Scenario Outline: <screen> offers no link "<link>"
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then there is no link "<link>"

      Examples: the organization
        | screen                      | kind         | name | rest      | link                    |
        | The organization's projects | organization | Acme |           | New project             |
        | The organization's settings | organization | Acme | /settings | Rename the organization |

      Examples: a project
        | screen    | kind    | name    | rest | link               |
        | A project | project | Web app |      | New fleet          |
        | A project | project | Web app |      | Rename the project |
        | A project | project | Web app |      | Delete project…    |

      Examples: a fleet and its emulators
        | screen  | kind  | name    | rest | link                            |
        | A fleet | fleet | Staging |      | Add an emulator                 |
        | A fleet | fleet | Staging |      | Rename the fleet                |
        | A fleet | fleet | Staging |      | Change who can call the fleet   |
        | A fleet | fleet | Staging |      | Change the requests per minute  |
        | A fleet | fleet | Staging |      | Change the durability of resend |
        | A fleet | fleet | Staging |      | Remove resend                   |
        | A fleet | fleet | Staging |      | Remove billing                  |
        | A fleet | fleet | Staging |      | Delete fleet…                   |

    Scenario: The fleet still shows everything the file declares for it
      When they open the fleet "Staging"
      Then they see the page "Staging"
      And the address of the fleet "Staging" is on screen with a "Copy URL" button
      And the setting "Name" reads "Staging"
      And the setting "Who can call it" reads "Anyone with the URL"
      And the setting "Requests per minute" reads "The organization's ceiling"
      And there is an emulator "resend"
      And there is an emulator "billing"
      And "Buffered" is the durability of "resend"
      And "Strict" is the durability of "billing"

    Scenario: A managed organization whose file declares no projects says to add them to the file
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <globex>
        name: Globex
        projects: {}
        """
      When they open the organization "Globex"
      Then they see "No projects yet"
      And they see "The file declares no projects. Add one to it and apply it."
      And there is no link "New project"
      And there is no link "Start from mockingbird.yaml"

    Scenario: A managed project without fleets, and a fleet without emulators, say the same
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <globex>
        name: Globex
        projects:
          docs:
            name: Docs
          api:
            name: Api
            fleets:
              <globex-api>:
                name: Preview
                services: {}
        """
      When they open the project "Docs"
      Then they see "The file declares no fleets for this project. Add one to it and apply it."
      And there is no link "New fleet"
      When they open the fleet "Preview"
      Then they see "The file declares no services for this fleet. Add one to it and apply it."
      And there is no link "Add an emulator"

  Rule: What the file does not declare stays available

    Scenario Outline: A fleet still offers <a> <control> "<name>"
      When they open the fleet "Staging"
      Then the screen says "You can still save, reset and download emulator state." beside that
      And there is <a> <control> "<name>"

      Examples:
        | a | control | name                          |
        | a | link    | Save resend now               |
        | a | link    | Reset the state of resend     |
        | a | link    | Reset the state of billing    |
        | a | button  | Download the state of resend  |
        | a | button  | Download the state of billing |

    Scenario: Resetting an emulator's state works as it does by hand
      Given 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      And they follow "Reset the state of resend"
      Then the screen is the "emulator.reset" form
      When they press "Reset state"
      Then they see the page "Staging"
      And the emulator "resend" is noted "Reset just now"
      And the email that was sent is gone from the "resend" emulator of "Staging"

    Scenario: Saving an emulator's state now works as it does by hand
      Given 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      And they follow "Save resend now"
      Then the screen is the "emulator.save" form
      When they press "Save now"
      Then they see the page "Staging"
      And the emulator "resend" is noted "Saved just now"

    Scenario: Downloading an emulator's state works as it does by hand
      Given 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      And they download the state of "resend"
      Then a file named after the fleet "Staging" and the emulator "resend" is saved
      And the saved file holds the email that was sent

    Scenario Outline: The <tab> tab still offers a link "<link>"
      When they open the "<tab>" tab of "Acme"
      Then there is a link "<link>"

      Examples:
        | tab      | link                 |
        | Members  | Invite someone       |
        | Members  | Leave                |
        | API keys | New API key          |
        | Settings | Delete organization… |

    Scenario: Someone can still be invited
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      And they type the email of Linus into "Email"
      And they press "Create invite link"
      Then they see the page "Invite link created"
      And an invite link is shown

    Scenario: A member's role can still be changed
      Given Grace has joined "Acme" with the member role
      When they open the "Members" tab of "Acme"
      And they follow "Change role" beside Grace
      And they choose "Admin" as the "Role"
      And they press "Change role"
      Then the role of Grace is "admin"

    Scenario: An API key can still be made
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "deploy" into "Name"
      And they press "Create API key"
      Then they see the page "API key created"
      And a secret starting with "mbf_o_" is shown

    Scenario: Usage and the audit log are still shown
      When they open the "Usage" tab of "Acme"
      Then the "Usage" tab is the current one
      And no problem is pointed out
      When they open the "Audit log" tab of "Acme"
      Then the "Audit log" tab is the current one
      And no problem is pointed out

    Scenario: The organization can still be deleted
      When they open the "Settings" tab of "Acme"
      And they follow "Delete organization…"
      Then the screen is the "org.delete" form
      When they type the slug of "Acme" into the confirmation
      And they press "Delete organization"
      Then they see the page "Organizations"
      And the address of the fleet "Staging" no longer answers

    Scenario: A member can still leave
      Given Grace has joined "Acme" with the member role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      And they follow "Leave" beside Grace
      And they press "Leave organization"
      Then they see the page "Organizations"

  Rule: The address of a hand edit says the file controls it, instead of showing a form

    Scenario Outline: The address for <what> says it is configured by mockingbird.yaml
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then they are told it is configured by mockingbird.yaml
      And they see "<says> is not available by hand in Acme."
      And they see "Change the file and apply it instead."
      And there is a link "How to change it"
      And there is a link "<back>"
      And the screen keeps the design rules

      Examples:
        | what                             | kind         | name    | rest                          | says                          | back             |
        | renaming the organization        | organization | Acme    | /rename                       | Renaming the organization     | Back to Settings |
        | creating a project               | organization | Acme    | /projects/new                 | Creating projects             | Back to Acme     |
        | renaming a project               | project      | Web app | /rename                       | Renaming a project            | Back to Web app  |
        | deleting a project               | project      | Web app | /delete                       | Deleting a project            | Back to Web app  |
        | creating a fleet                 | project      | Web app | /fleets/new                   | Creating fleets               | Back to Web app  |
        | renaming a fleet                 | fleet        | Staging | /rename                       | Renaming a fleet              | Back to Staging  |
        | changing who can call a fleet    | fleet        | Staging | /access                       | Changing a fleet's access     | Back to Staging  |
        | changing a fleet's rate limit    | fleet        | Staging | /rate-limit                   | Changing a fleet's rate limit | Back to Staging  |
        | deleting a fleet                 | fleet        | Staging | /delete                       | Deleting a fleet              | Back to Staging  |
        | choosing an emulator to add      | fleet        | Staging | /add-emulator                 | Adding emulators              | Back to Staging  |
        | adding an emulator               | fleet        | Staging | /add-emulator/stripe          | Adding emulators              | Back to Staging  |
        | changing an emulator's durability | fleet       | Staging | /emulators/resend/durability  | Changing durability           | Back to Staging  |
        | removing an emulator             | fleet        | Staging | /emulators/resend/remove      | Removing an emulator          | Back to Staging  |

    Scenario: The statement says who applied the file, and leads to the Configuration tab
      When they open the address of the fleet "Staging" followed by "/rename"
      Then they see the email of Ada
      When they follow "How to change it"
      Then the "Configuration" tab is the current one
      And the address is that of the "Configuration" tab of "Acme"

    Scenario: The statement leads back to the thing the address was about
      When they open the address of the fleet "Staging" followed by "/rename"
      And they follow "Back to Staging"
      Then they see the page "Staging"
      And the address is that of the fleet "Staging"

    Scenario Outline: The address for <what> still shows its form
      When they open the address of the fleet "Staging" followed by "<rest>"
      Then the screen is the "<form>" form

      Examples:
        | what                         | rest                    | form           |
        | saving an emulator's state   | /emulators/resend/save  | emulator.save  |
        | resetting an emulator's state | /emulators/resend/reset | emulator.reset |

    Scenario: Someone whose role could not make the change anyway is told that instead
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the address of the fleet "Staging" followed by "/rename"
      Then they are told they have no access

  Rule: A form that was open when the file took control says so when it is sent

    Background:
      Given Ada has released the organization "Acme" from its file

    Scenario Outline: The form for <what>, sent after the file was applied, is refused in its summary
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then the screen is the "<form>" form
      When Ada applies it
      And they press "<button>"
      Then the form says "This organization is configured by mockingbird.yaml, so this cannot be changed by hand."
      And the form says "Change the file and apply it"
      And no field is marked wrong
      And the form's summary has the focus
      And the screen keeps the design rules
      And Fleet Cloud still matches the file that was applied

      Examples:
        | what                              | kind         | name    | rest                         | form                | button          |
        | renaming the organization         | organization | Acme    | /rename                      | org.rename          | Rename organization |
        | renaming a project                | project      | Web app | /rename                      | project.rename      | Rename project  |
        | deleting a project                | project      | Web app | /delete                      | project.delete      | Delete project  |
        | renaming a fleet                  | fleet        | Staging | /rename                      | fleet.rename        | Rename fleet    |
        | deleting a fleet                  | fleet        | Staging | /delete                      | fleet.delete        | Delete fleet    |
        | removing an emulator              | fleet        | Staging | /emulators/resend/remove     | emulator.remove     | Remove emulator |

    Scenario: Changing who can call a fleet is refused the same way, and the fleet stays as declared
      When they open the address of the fleet "Staging" followed by "/access"
      And they choose "Only requests with an API key" as the "Who can call this fleet"
      And Ada applies it
      And they press "Save access"
      Then the form says "This organization is configured by mockingbird.yaml, so this cannot be changed by hand."
      And no field is marked wrong
      And the fleet "acme-staging" is configured as:
        | access | open |

    Scenario: Changing an emulator's durability is refused the same way, and it stays as declared
      When they open the address of the fleet "Staging" followed by "/emulators/resend/durability"
      And they choose "Strict" as the "Durability"
      And Ada applies it
      And they press "Save durability"
      Then the form says "This organization is configured by mockingbird.yaml, so this cannot be changed by hand."
      And no field is marked wrong
      And the emulators of "acme-staging" are:
        | name    | durability |
        | resend  | buffered   |
        | billing | strict     |

    Scenario: A form that creates something is refused the same way
      When they open the address of the organization "Acme" followed by "/projects/new"
      And they type "Made by hand" into "Name"
      And Ada applies it
      And they press "Create project"
      Then the form says "This organization is configured by mockingbird.yaml, so this cannot be changed by hand."
      And no field is marked wrong
      And the organization "Acme" has exactly these projects and fleets:
        | project | name    | fleets       |
        | web     | Web app | acme-staging |

    Scenario: Opened again, the address of the refused form says the file controls it
      When they open the address of the fleet "Staging" followed by "/rename"
      And Ada applies it
      And they press "Rename fleet"
      And they reload the page
      Then they are told it is configured by mockingbird.yaml

  Rule: After an apply, the dashboard shows what the file now declares

    Scenario: Names, access and the request rate on screen follow the file
      Given Ada changes the file to:
        """
        version: 1
        organization: <acme>
        name: Acme Inc
        projects:
          web:
            name: Website
            fleets:
              <acme-staging>:
                name: Preview
                access: key
                requestsPerMinute: 300
                services:
                  resend: {}
                  billing: { target: stripe, durability: strict }
        """
      And Ada has applied it
      When they open the fleet "Preview"
      Then they see the page "Preview"
      And the breadcrumb reads "Organizations, Acme Inc, Website, Preview"
      And the setting "Who can call it" reads "Only requests with an API key"
      And the setting "Requests per minute" reads "300"

    Scenario: An emulator added to the file appears on the fleet
      Given Ada adds under "services:" in the file:
        """
        mail: { target: resend, durability: ephemeral }
        """
      And Ada has applied it
      When they open the fleet "Staging"
      Then there is an emulator "mail"
      And "Ephemeral" is the durability of "mail"
      And there is no link "Remove mail"

    Scenario: An emulator pruned from the file is gone from the fleet
      Given Ada removes the line "billing: { target: stripe, durability: strict }" from the file
      And Ada has applied it with prune
      When they open the fleet "Staging"
      Then there is an emulator "resend"
      And there is no emulator "billing"

    Scenario: A project and a fleet added to the file are listed
      Given Ada adds under "projects:" in the file:
        """
        api:
          name: Api
          fleets:
            <acme-api>:
              name: Sandbox
              services:
                stripe: {}
        """
      And Ada has applied it
      When they open the organization "Acme"
      And they follow the project "Api"
      Then they see the page "Api"
      And the screen says it is configured by mockingbird.yaml, last applied by Ada
      When they follow the fleet "Sandbox"
      Then there is an emulator "stripe"

    Scenario: A service the file marks local-only is in the file but not on the fleet
      Given Ada adds under "services:" in the file:
        """
        db: { target: postgres, protocol: postgres, local: true }
        """
      And Ada has applied it
      When they open the fleet "Staging"
      Then there is no emulator "db"
      When they open the "Configuration" tab of "Acme"
      Then the file on screen is the mockingbird.yaml that was applied

    Scenario: A screen that was open is brought up to date by reloading it
      When they open the fleet "Staging"
      And Ada changes "name: Staging" to "name: Preview" in the file
      And Ada applies it
      And they reload the page
      Then they see the page "Preview"
