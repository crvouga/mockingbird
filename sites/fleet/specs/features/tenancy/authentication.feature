@tenancy
Feature: Authenticating to the API
  Every call to the control API is made by someone: a person with a browser session, a personal
  token acting as that person, or an API key acting for an organization. Anyone else is refused.

  Rule: Callers must prove who they are

    Scenario: An anonymous caller is refused
      When an anonymous caller asks who they are
      Then the request is refused as "unauthorized"
      And the response status is 401
      And the message says "Sign in or send an API key"

    Scenario Outline: A caller presenting <credential> is refused
      When a caller presenting <credential> asks who they are
      Then the request is refused as "unauthorized"
      And the response status is 401
      And the message says "<reason>"

      Examples:
        | credential                                         | reason                     |
        | a malformed key                                    | Malformed API key          |
        | a well-formed key that was never issued            | Unknown or expired API key |
        | a well-formed personal token that was never issued | Unknown or expired API key |

    Scenario: An expired credential is refused
      Given Ada has a personal token "laptop" that expires in 1 day
      When the token "laptop" has passed its expiry
      And the token "laptop" asks who they are
      Then the request is refused as "unauthorized"
      And the message says "Unknown or expired API key"

    Scenario: A revoked credential is refused
      Given Ada has a personal token "laptop"
      When Ada revokes the personal token "laptop"
      And the token "laptop" asks who they are
      Then the request is refused as "unauthorized"

    Scenario: A key may be sent in the dedicated API-key header instead of as a bearer credential
      Given Ada owns an organization "Acme"
      And Ada has an organization key "ci" for "Acme" with the member role
      When the key "ci" is presented in the dedicated API-key header
      Then they are recognised as an API key of "Acme" with the member role

  Rule: A browser session is trusted to change things only when the request came from the dashboard

    Background:
      Given Ada is signed in

    Scenario: A session identifies the person who signed in
      When Ada asks who they are
      Then they are recognised as the person Ada

    Scenario: Reading needs nothing but the session
      When Ada's browser reads their organizations without the anti-forgery header
      Then the request succeeds

    Scenario: A change without the anti-forgery header is refused
      When Ada's browser tries to create an organization without the anti-forgery header
      Then the request is refused as "forbidden"
      And Ada belongs to no organizations

    Scenario: A change sent from another website is refused
      When Ada's browser tries to create an organization from the website "https://evil.example"
      Then the request is refused as "forbidden"
      And Ada belongs to no organizations

    Scenario: A change sent from the dashboard itself is accepted
      When Ada's browser tries to create an organization from the dashboard itself
      Then the request succeeds

    Scenario: An expired session is no longer a credential
      When Ada's session has passed its expiry
      And Ada asks who they are
      Then the request is refused as "unauthorized"

    Scenario: Signing out ends the session
      When Ada signs out
      And Ada asks who they are
      Then the request is refused as "unauthorized"

    Scenario: Another website cannot sign someone out
      When Ada tries to sign out without the anti-forgery header
      Then the request is refused as "forbidden"
      And Ada is still signed in

  Rule: A personal token acts as its person; an API key acts for its organization

    Background:
      Given Ada owns an organization "Acme"

    Scenario: A personal token is recognised as the person who made it
      Given Ada has a personal token "laptop"
      When the token "laptop" asks who they are
      Then they are recognised as the person Ada

    Scenario: A personal token changes things without a browser's anti-forgery header
      Given Ada has a personal token "laptop"
      When the token "laptop" creates an organization named "Side project"
      Then the request succeeds
      And Ada is an owner of "Side project"

    Scenario: A personal token can be exchanged for a browser session
      Given Ada has a personal token "laptop"
      When the token "laptop" is exchanged for a browser session
      Then the request succeeds
      And the new browser session belongs to Ada

    Scenario: An organization key cannot be exchanged for a browser session
      Given Ada has an organization key "ci" for "Acme" with the admin role
      When the key "ci" is exchanged for a browser session
      Then the request is refused as "unauthorized"
      And the message says "Sign in with a personal token"

    Scenario: An organization key is recognised as a key, not as a person
      Given Ada has an organization key "ci" for "Acme" with the member role
      When the key "ci" asks who they are
      Then they are recognised as an API key of "Acme" with the member role

    Scenario: An organization key cannot do what only a person can
      Given Ada has an organization key "ci" for "Acme" with the admin role
      When the key "ci" creates an organization named "Another"
      Then the request is refused as "forbidden"
      And the message says "needs a signed-in user or a personal token"
