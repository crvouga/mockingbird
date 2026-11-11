@tenancy
Feature: Invites
  The service sends no email. Inviting someone produces a link for the inviter to share; whoever
  opens it while signed in joins the organization with the role the invite carries.

  Background:
    Given Ada owns an organization "Acme"

  Rule: An invite is a link that carries a role

    Scenario: Inviting someone produces a link to share
      When Ada invites Grace to "Acme" as a viewer
      Then the response status is 201
      And the invite for Grace is a link to the dashboard
      And the pending invites of "Acme" are:
        | person | role   |
        | Grace  | viewer |

    Scenario: An invite grants the member role unless told otherwise
      When Ada invites Grace to "Acme" without naming a role
      Then the pending invites of "Acme" are:
        | person | role   |
        | Grace  | member |

    Scenario: An invite is good for seven days
      When Ada invites Grace to "Acme" as a member
      Then the invite for Grace expires 7 days after it was made

    Scenario: Nobody can be invited as an owner
      When Ada invites Grace to "Acme" as an owner
      Then the request is refused as "invalid_request"
      And "Acme" has no pending invites

    Scenario: An invite needs an email address
      When Ada invites the address "not-an-email" to "Acme"
      Then the request is refused as "invalid_request"
      And "Acme" has no pending invites

    Scenario: The link is shown once
      Given Ada has invited Grace to "Acme" as a member
      Then the pending invites of "Acme" do not reveal the link for Grace

    Scenario: An admin key can invite people
      Given Ada has an organization key "ops" for "Acme" with the admin role
      When the key "ops" invites Grace to "Acme" as a viewer
      Then the response status is 201

  Rule: Accepting an invite makes you a member with its role

    Scenario Outline: Accepting an invite as <a role> makes you <a role>
      Given Ada has invited Grace to "Acme" as <a role>
      When Grace accepts their invite
      Then the request succeeds
      And Grace is <a role> of "Acme"

      Examples:
        | a role    |
        | a viewer  |
        | a member  |
        | an admin  |

    Scenario: An accepted invite is no longer pending
      Given Ada has invited Grace to "Acme" as a member
      When Grace accepts their invite
      Then "Acme" has no pending invites
      And "Acme" has 2 members

    Scenario: The link admits whoever holds it, whatever address it was made out to
      Given Ada has invited Grace to "Acme" as a viewer
      When Linus accepts the invite meant for Grace
      Then the request succeeds
      And Linus is a viewer of "Acme"

    Scenario: Someone already in the organization keeps the role they have
      Given Tess has joined "Acme" with the admin role
      And Ada has invited Grace to "Acme" as a viewer
      When Tess accepts the invite meant for Grace
      Then the request succeeds
      And Tess is still an admin of "Acme"
      And "Acme" has no pending invites

    Scenario: Accepting needs a signed-in person
      Given Ada has invited Grace to "Acme" as a member
      When an anonymous caller accepts the invite meant for Grace
      Then the request is refused as "unauthorized"
      And the invite for Grace is still pending in "Acme"

    Scenario: An API key cannot accept an invite
      Given Grace owns an organization "Globex"
      And Grace has an organization key "bot" for "Globex" with the admin role
      And Ada has invited Grace to "Acme" as a member
      When the key "bot" accepts the invite meant for Grace
      Then the request is refused as "forbidden"
      And the invite for Grace is still pending in "Acme"

  Rule: An invite admits exactly one person

    Background:
      Given Ada has invited Grace to "Acme" as a member

    Scenario: A used link does not work again
      Given Grace accepts their invite
      When Linus accepts the invite meant for Grace
      Then the request is refused as "not_found"
      And the message says "This invite is invalid, already used or expired"
      And Linus cannot see "Acme"

    Scenario: Two people using one link at the same moment
      When Grace and Linus accept the invite meant for Grace at the same moment
      Then exactly one of Grace and Linus has joined "Acme"
      And "Acme" has 2 members
      And "Acme" has no pending invites

  Rule: An invite stops working when it is revoked or expires

    Background:
      Given Ada has invited Grace to "Acme" as a member

    Scenario: A revoked invite stops working
      When Ada revokes the invite for Grace in "Acme"
      Then the request succeeds
      And "Acme" has no pending invites

    Scenario: A revoked link no longer admits anyone
      Given Ada revokes the invite for Grace in "Acme"
      When Grace accepts their invite
      Then the request is refused as "not_found"
      And Grace cannot see "Acme"

    Scenario: An expired link no longer admits anyone
      Given the invite for Grace has passed its expiry
      When Grace accepts their invite
      Then the request is refused as "not_found"
      And the message says "This invite is invalid, already used or expired"
      And Grace cannot see "Acme"

    Scenario: A link that was never issued admits no one
      When Linus accepts an invite link that was never issued
      Then the request is refused as "not_found"

    Scenario: An invite can only be revoked from its own organization
      Given Mallory owns an organization "Globex"
      When Mallory revokes the invite for Grace in "Globex"
      Then the request is refused as "not_found"
      And the invite for Grace is still pending in "Acme"
