@dashboard
Feature: Members of an organization in the dashboard
  The Members tab lists who belongs to an organization and with which role. Admins and owners
  change roles, remove people and invite new ones; anyone can leave.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Grace has joined "Acme" with the member role

  Scenario: Members are listed with their roles and the reader is marked
    When they open the "Members" tab of "Acme"
    Then the member Ada is listed as "(you)"
    And the role of Ada is "owner"
    And the role of Grace is "member"

  Scenario: Changing a member's role takes effect at once and lasts
    When they open the "Members" tab of "Acme"
    And they change the role of Grace to "admin"
    Then the role of Grace is "admin"
    When they reload the page
    Then the role of Grace is "admin"

  Scenario: The last owner cannot step down, and is told why
    When they open the "Members" tab of "Acme"
    And they change the role of Ada to "admin"
    Then they see the error "at least one owner"
    When they reload the page
    Then the role of Ada is "owner"

  Scenario: Removing a member asks first
    When they open the "Members" tab of "Acme"
    And they remove the member Grace and confirm
    Then they were asked to remove Grace
    And Grace is no longer listed as a member

  Scenario: Declining the question keeps the member
    When they open the "Members" tab of "Acme"
    And they remove the member Grace and decline
    And they reload the page
    Then the role of Grace is "member"

  Scenario: Leaving an organization returns to the list of organizations
    Given Grace is signed in to the dashboard
    When they open the "Members" tab of "Acme"
    And they press "Leave" and confirm
    Then they were asked "Leave Acme?"
    And they see the page "Organizations"
    And they see "No organizations yet"

  Rule: New people join through an invite link

    Scenario: Creating an invite shows its link once
      When they open the "Members" tab of "Acme"
      And they invite Linus as a "viewer"
      Then they see "Invite link created. Copy it now; it will not be shown again."
      And an invite link is shown
      And the pending invite for Linus says "viewer"

    Scenario: The invite link is gone after leaving the page
      When they open the "Members" tab of "Acme"
      And they invite Linus as a "viewer"
      And they follow "Usage"
      And they follow "Members"
      Then no secret is shown
      And the pending invite for Linus says "viewer"

    Scenario: Opening the link in another browser joins the organization
      When they open the "Members" tab of "Acme"
      And they invite Linus as a "viewer"
      And Linus opens the invite link in a browser of his own and signs in locally
      Then they see the page "Acme"
      And they see "You are a viewer of this organization."
      When Ada returns to her own browser
      And they reload the page
      Then the role of Linus is "viewer"
      And there are no pending invites

    Scenario: Someone already signed in joins by opening the link
      Given Ada has invited Linus to "Acme" as an admin
      And Linus is signed in to the dashboard
      When they open the invite link for Linus
      Then they see the page "Acme"
      And they see "You are an admin of this organization."
      And the address is that of the organization "Acme"

    Scenario: A link that does not exist is reported
      When they open the dashboard at "/invite/not-a-real-invite"
      Then they see "Not found"

    Scenario: Revoking a pending invite removes it
      Given Ada has invited Linus to "Acme" as a viewer
      When they open the "Members" tab of "Acme"
      And they revoke the invite for Linus
      Then there are no pending invites
