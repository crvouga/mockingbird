@declarative
Feature: Who may apply a mockingbird.yaml
  Applying a file reconfigures a whole organization, so it takes an admin: a person who is an
  admin or owner, or an admin API key, which is what a pipeline uses. Only a person can bring a
  new organization into being. Anyone else is refused, and someone outside the organization
  cannot even tell it exists.

  Background:
    Given Ada has applied this mockingbird.yaml:
      """
      version: 1
      organization: <acme>
      projects:
        web:
          fleets:
            <acme-staging>:
              access: open
              services:
                resend: { durability: strict }
      """
    And she changes "access: open" to "access: key" in the file

  Rule: Admins and owners may apply

    Scenario Outline: A person with the <role> role applies the file
      Given Bo has joined "acme" with the <role> role
      When Bo applies it
      Then the file is reported as applied
      And the fleet "acme-staging" is configured as:
        | access | key |
      And the organization "acme" is managed by the file Bo applied

      Examples:
        | role  |
        | admin |
        | owner |

    Scenario: An admin API key applies the file, as a pipeline would
      Given Ada has an organization key "ci" for "acme" with the admin role
      When the key "ci" applies it
      Then the file is reported as applied
      And the fleet "acme-staging" is configured as:
        | access | key |
      And the organization "acme" is managed by the file the key "ci" applied

    Scenario: Applying does not change who owns the organization
      Given Bo has joined "acme" with the admin role
      When Bo applies it
      Then Ada is the owner of the organization "acme"
      And Bo is an admin of "acme"

  Rule: Anyone below an admin may not apply, or even plan

    Scenario Outline: A person with the <role> role may not <verb> the file
      Given Bo has joined "acme" with the <role> role
      When Bo <verbs> it
      Then the request is refused as "forbidden"
      And the message says "This needs the admin role or higher"
      And the fleet "acme-staging" is configured as:
        | access | open |

      Examples:
        | role   | verb  | verbs   |
        | member | apply | applies |
        | viewer | apply | applies |
        | member | plan  | plans   |
        | viewer | plan  | plans   |

    Scenario Outline: A <role> API key may not apply the file
      Given Ada has an organization key "ci" for "acme" with the <role> role
      When the key "ci" applies it
      Then the request is refused as "forbidden"
      And the fleet "acme-staging" is configured as:
        | access | open |

      Examples:
        | role   |
        | member |
        | viewer |

    Scenario: A key for one project cannot see the organization, so it may not apply its file
      Given Ada has a project key "web-ci" for the project "web" with the member role
      When the key "web-ci" applies it
      Then the request is refused as "not_found"
      And the fleet "acme-staging" is configured as:
        | access | open |

  Rule: Outsiders cannot tell the organization exists

    Scenario Outline: Someone outside the organization who <verbs> its file is told it is not found
      When Eve <verbs> it
      Then the request is refused as "not_found"
      And the response status is 404
      And Eve belongs to no organizations
      And the fleet "acme-staging" is configured as:
        | access | open |

      Examples:
        | verbs   |
        | applies |
        | plans   |

    Scenario: An anonymous caller is refused
      When an anonymous caller applies it
      Then the response status is 401
      And the request is refused as "unauthorized"
      And the fleet "acme-staging" is configured as:
        | access | open |

  Rule: Only a person can create an organization

    Scenario: An API key cannot apply a file that declares a new organization
      Given Ada has an organization key "ci" for "acme" with the admin role
      When the key "ci" applies a copy of the file that declares the organization "globex" instead
      Then the request is refused as "not_found"
      And the refusal says "an API key cannot create one; apply once with a personal token"

    Scenario: A key of one organization cannot apply to another
      Given Bo has applied this mockingbird.yaml:
        """
        version: 1
        organization: <bobs>
        projects: {}
        """
      And Bo has an organization key "bobs-ci" for "bobs" with the admin role
      When the key "bobs-ci" applies a copy of the file that declares the organization "acme" instead
      Then the request is refused as "not_found"

    Scenario: A person who applies a file naming a new organization becomes its owner
      When Bo applies this mockingbird.yaml of his own:
        """
        version: 1
        organization: <bobs>
        projects: {}
        """
      Then the file is reported as applied
      And Bo is the owner of the organization "bobs"

  Rule: A suspended organization cannot be applied to

    Background:
      Given the operator has suspended Ada's organization for "unpaid invoice"

    Scenario: Applying to a suspended organization is refused with the reason
      When Ada applies it
      Then the response status is 403
      And the request is refused as "org_suspended"
      And the message says "unpaid invoice"
      And the fleet "acme-staging" is configured as:
        | access | open |

    Scenario: Planning for a suspended organization is refused too
      When Ada plans it
      Then the request is refused as "org_suspended"

    Scenario: Once reinstated, the organization can be applied to again
      When the operator reinstates Ada's organization
      And Ada applies it
      Then the file is reported as applied
