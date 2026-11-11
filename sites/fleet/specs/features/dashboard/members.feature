@dashboard
Feature: Members of an organization in the dashboard
  The Members tab lists who belongs to an organization and with which role, and the invites that
  are waiting. Changing someone's role, removing them, leaving, inviting someone and revoking an
  invite each happen on a screen of their own, reached by the link beside the person or invite.
  Joining with an invite link is a screen of its own too: opening a link joins nothing by itself.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Grace has joined "Acme" with the member role

  Rule: The Members tab lists the members

    Scenario: Members are listed with their roles, and the reader is marked
      When they open the "Members" tab of "Acme"
      Then the member Ada is listed as "you"
      And the role of Ada is "owner"
      And the role of Grace is "member"
      And there is a link "Invite someone"

  Rule: A role is changed on a screen of its own

    Scenario: Changing a member's role notes the change beside them
      When they open the "Members" tab of "Acme"
      And they follow "Change role" beside Grace
      Then they see the form to change the role of Grace
      And the screen is the "member.role" form
      And "Member" is chosen for "Role"
      When they choose "Admin" as the "Role"
      And they press "Change role"
      Then the "Members" tab is the current one
      And the role of Grace is "admin"
      And the member Grace is noted "Role changed just now"
      When they reload the page
      Then the role of Grace is "admin"
      And no note is shown

    Scenario: Choosing the role they already have is pointed out
      When they open the "Members" tab of "Acme"
      And they follow "Change role" beside Grace
      And they press "Change role"
      Then the field "Role" says "already has this role. Choose a different one."
      And exactly 1 problem is pointed out

    Scenario: The last owner cannot step down, and the role field says why
      When they open the "Members" tab of "Acme"
      And they follow "Change role" beside Ada
      And they choose "Admin" as the "Role"
      And they press "Change role"
      Then the field "Role" says "An organization needs at least one owner"
      And exactly 1 problem is pointed out
      When they cancel
      Then the role of Ada is "owner"

    Scenario: Cancel keeps the role
      When they open the "Members" tab of "Acme"
      And they follow "Change role" beside Grace
      And they choose "Viewer" as the "Role"
      And they cancel
      Then the role of Grace is "member"
      And no note is shown

  Rule: A member is removed on a screen of their own

    Scenario: Removing a member says what they lose, then takes them off the list
      When they open the "Members" tab of "Acme"
      And they follow "Remove" beside Grace
      Then they see the form to remove Grace from "Acme"
      And the screen is the "member.remove" form
      And they see "API keys they created keep working until you revoke them."
      When they press "Remove member"
      Then the "Members" tab is the current one
      And they see the note "was removed just now."
      And Grace is no longer listed as a member

    Scenario: Cancelling keeps the member
      When they open the "Members" tab of "Acme"
      And they follow "Remove" beside Grace
      And they cancel
      Then the role of Grace is "member"

    Scenario: A member who left in the meantime is reported in the form
      When they open the "Members" tab of "Acme"
      And they follow "Remove" beside Grace
      And Grace leaves "Acme"
      And they press "Remove member"
      Then the form says "The member was not removed."
      And no field is marked wrong

  Rule: Anyone can leave, on a screen of its own, except the last owner

    Scenario: Leaving an organization returns to the list of organizations
      Given Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      And they follow "Leave" beside Grace
      Then they see the page "Leave Acme"
      And the screen is the "org.leave" form
      When they press "Leave organization"
      Then they see the page "Organizations"
      And they see the note "You left Acme just now."
      And they see "You are not in any organization yet"

    Scenario: The last owner cannot leave, and the form says why
      When they open the "Members" tab of "Acme"
      And they follow "Leave" beside Ada
      And they press "Leave organization"
      Then the form says "You are still a member."
      And the form says "An organization needs at least one owner"
      And they see the page "Leave Acme"

    Scenario: Cancelling keeps the membership
      Given Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      And they follow "Leave" beside Grace
      And they cancel
      Then the "Members" tab is the current one
      And the role of Grace is "member"

  Rule: New people join through an invite link, created on a screen of its own and shown once

    Scenario: Creating an invite shows its link once, then lists it as pending
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      Then they see the page "Invite someone to Acme"
      And the screen is the "invite.new" form
      And the choices for "Role" are "Viewer, Member, Admin"
      And "Member" is chosen for "Role"
      When they type the email of Linus into "Email"
      And they choose "Viewer" as the "Role"
      And they press "Create invite link"
      Then they see the page "Invite link created"
      And an invite link is shown
      And they see "Send this link to"
      When they follow "Done"
      Then the "Members" tab is the current one
      And the pending invite for Linus says "viewer"

    Scenario: An address without an @ is pointed out before asking the server
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      And they type "linus" into "Email"
      And they press "Create invite link"
      Then the field "Email" says "Enter an email address with an @, like teammate@example.com."

    Scenario: An empty address is pointed out under the field
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      And they press "Create invite link"
      Then the field "Email" says "Enter the email address of the person you are inviting."
      And exactly 1 problem is pointed out

    Scenario: The invite link is gone after leaving its screen
      When they open the "Members" tab of "Acme"
      And they invite Linus as a "Viewer"
      And they follow "Done"
      And they go back
      Then they are told the secret was shown once
      When they open the "Members" tab of "Acme"
      Then the pending invite for Linus says "viewer"

    Scenario: Cancel creates no invite
      When they open the "Members" tab of "Acme"
      And they follow "Invite someone"
      And they type the email of Linus into "Email"
      And they cancel
      Then there are no pending invites

    Scenario: Opening the link in another browser asks to sign in, then to join
      When they open the "Members" tab of "Acme"
      And they invite Linus as a "Viewer"
      And Linus opens the invite link in a browser of his own and signs in locally
      Then they see the page "Join an organization"
      And the screen is the "invite.accept" form
      When they press "Join"
      Then they see the page "Acme"
      And they see the note "Joined just now"
      And they see "You are a viewer of this organization."
      When Ada returns to her own browser
      And they open the "Members" tab of "Acme"
      Then the role of Linus is "viewer"
      And there are no pending invites

    Scenario: Someone already signed in joins by opening the link and pressing Join
      Given Ada has invited Linus to "Acme" as an admin
      And Linus is signed in to the dashboard
      When they open the invite link for Linus
      Then they see the page "Join an organization"
      And they see the email of Linus
      When they press "Join"
      Then they see the page "Acme"
      And they see "You are an admin of this organization."
      And the address is that of the organization "Acme"

    Scenario: Cancelling an invite link joins nothing
      Given Ada has invited Linus to "Acme" as an admin
      And Linus is signed in to the dashboard
      When they open the invite link for Linus
      And they cancel
      Then they see the page "Organizations"
      And they see "You are not in any organization yet"

    Scenario: A link that was already used is refused in the form
      Given Ada has invited Linus to "Acme" as a viewer
      And Linus accepts their invite
      And Hedy is signed in to the dashboard
      When they open the invite link for Linus
      And they press "Join"
      Then the form says "You did not join."
      And the form says "This invite is invalid, already used or expired"
      And they see the page "Join an organization"

    Scenario: A link that was never issued is refused in the form
      Given Linus is signed in to the dashboard
      When they open the dashboard at "/invite/not-a-real-invite"
      And they press "Join"
      Then the form says "This invite is invalid, already used or expired"
      And no field is marked wrong

  Rule: A pending invite is revoked on a screen of its own

    Background:
      Given Ada has invited Linus to "Acme" as a viewer

    Scenario: Revoking a pending invite removes it, noting what was revoked
      When they open the "Members" tab of "Acme"
      And they follow "Revoke" beside the invite for Linus
      Then they see the page for revoking the invite for Linus
      And the screen is the "invite.revoke" form
      When they press "Revoke invite"
      Then they see the note "was revoked just now."
      And there are no pending invites

    Scenario: A revoked link no longer joins
      When they open the "Members" tab of "Acme"
      And they follow "Revoke" beside the invite for Linus
      And they press "Revoke invite"
      And Linus is signed in to the dashboard
      And they open the invite link for Linus
      And they press "Join"
      Then the form says "This invite is invalid, already used or expired"

    Scenario: Cancelling keeps the invite
      When they open the "Members" tab of "Acme"
      And they follow "Revoke" beside the invite for Linus
      And they cancel
      Then the pending invite for Linus says "viewer"

    Scenario: An invite accepted in the meantime is reported in the form
      When they open the "Members" tab of "Acme"
      And they follow "Revoke" beside the invite for Linus
      And Linus accepts their invite
      And they press "Revoke invite"
      Then the form says "The invite was not revoked."
      And no field is marked wrong
