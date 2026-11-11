@dashboard
Feature: Organization settings in the dashboard
  The Settings tab shows an organization's name, slug and id. Admins rename it on a screen of its
  own; only an owner can delete it, on a screen that asks them to type its slug first.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Rule: The Settings tab shows what identifies the organization

    Scenario: The settings show the name, the permanent slug and the id
      When they open the "Settings" tab of "Acme"
      Then the setting "Name" reads "Acme"
      And the setting "Slug" reads the slug of "Acme"
      And the setting "Slug" reads "Permanent"
      And the setting "ID" reads the id of "Acme"

  Rule: An organization is renamed on a screen of its own

    Scenario: Renaming the organization notes the new name beside it
      When they open the "Settings" tab of "Acme"
      And they follow "Rename the organization"
      Then they see the page "Rename Acme"
      And the screen is the "org.rename" form
      And the field "Name" holds "Acme"
      When they type "Acme Corporation" into "Name"
      And they press "Rename organization"
      Then they see the page "Acme Corporation"
      And the "Settings" tab is the current one
      And the setting "Name" is noted "Renamed just now"
      When they reload the page
      Then they see the page "Acme Corporation"
      And no note is shown

    Scenario: An empty name is pointed out under the field
      When they open the "Settings" tab of "Acme"
      And they follow "Rename the organization"
      And they clear "Name"
      And they press "Rename organization"
      Then the field "Name" says "Enter a name for the organization."
      And exactly 1 problem is pointed out

    Scenario: Cancel keeps the name
      When they open the "Settings" tab of "Acme"
      And they follow "Rename the organization"
      And they type "Acme Corporation" into "Name"
      And they cancel
      Then they see the page "Acme"
      And the "Settings" tab is the current one

    Scenario: A suspended organization cannot be renamed, and the form says why
      Given the operator has suspended "Acme" for "unpaid invoice"
      When they open the "Settings" tab of "Acme"
      And they follow "Rename the organization"
      And they type "Acme Corporation" into "Name"
      And they press "Rename organization"
      Then the form says "The organization was not renamed."
      And the form says "This organization is suspended: unpaid invoice."
      And no field is marked wrong

  Rule: An owner deletes the organization after typing its slug

    Scenario: Deleting the organization returns to the list, noting what was deleted
      When they open the "Settings" tab of "Acme"
      Then they see "Deletes every project, fleet, API key and all stored emulator state. This cannot be undone."
      When they follow "Delete organization…"
      Then they see the page "Delete Acme"
      And the screen is the "org.delete" form
      When they type the slug of "Acme" into the confirmation
      And they press "Delete organization"
      Then they see the page "Organizations"
      And they see the note "Acme was deleted just now."
      And they see "You are not in any organization yet"

    Scenario: A confirmation that does not match is pointed out, and nothing is deleted
      When they open the "Settings" tab of "Acme"
      And they follow "Delete organization…"
      And they type "acme" into the confirmation
      And they press "Delete organization"
      Then the confirmation says "That does not match."
      And exactly 1 problem is pointed out
      When they cancel
      Then they see the page "Acme"

    Scenario: An empty confirmation is pointed out
      When they open the "Settings" tab of "Acme"
      And they follow "Delete organization…"
      And they press "Delete organization"
      Then the confirmation says "to confirm that you want to delete it."

    Scenario: Cancelling keeps the organization
      When they open the "Settings" tab of "Acme"
      And they follow "Delete organization…"
      And they type the slug of "Acme" into the confirmation
      And they cancel
      Then they see the page "Acme"
      And the "Settings" tab is the current one
