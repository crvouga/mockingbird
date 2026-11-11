@fleets @operator
Feature: Operator controls
  Whoever runs the service holds an operator token. With it they can see every organization,
  raise or lower one organization's quotas, and suspend an organization that should not be
  served. Without a configured token there is no operator API at all.

  Rule: Only the operator token reaches the operator API

    Background:
      Given Ada has an open fleet "Staging" with a buffered Resend emulator

    Scenario: The operator token is accepted
      When the operator API is called presenting the operator token
      Then the response status is 200

    Scenario Outline: The operator API refuses <credential>
      When the operator API is called presenting <credential>
      Then the response status is 401
      And the request is refused as "unauthorized"

      Examples:
        | credential                                    |
        | no credential                                 |
        | the dashboard session of an owner             |
        | the personal token of an owner                |
        | an organization's admin key                   |
        | the operator token with one character changed |

    Scenario: No tenant credential can suspend an organization
      When Ada tries to suspend her own organization through the operator API
      Then the response status is 401

    Scenario: The operator token is not a user and opens nothing else
      When the operator token is presented to list organizations as a user would
      Then the response status is 401

  Rule: Without a configured token there is no operator API

    Scenario: The operator API says how to turn it on
      Given the server is configured with:
        | OPERATOR_TOKEN |  |
      When the operator API is called presenting the operator token
      Then the response status is 404
      And the request is refused as "operator_api_disabled"
      And the message says "Set OPERATOR_TOKEN"

  Rule: The operator sees every organization and its usage

    Scenario: The list shows an organization with its limits and this month's requests
      Given Ada has an open fleet "Staging" with an ephemeral Resend emulator
      And Grace has an open fleet "Preview" with an ephemeral Resend emulator
      And SDKs have sent 3 emails through "Staging"
      When the operator lists every organization
      Then the list shows Ada's organization with 3 emulator requests this month
      And the list shows Grace's organization with 0 emulator requests this month
      And the list shows the quotas that apply to Ada's organization

  Rule: The operator overrides one organization's quotas

    Background:
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And Grace has an open fleet "Preview" with a strict Resend emulator

    Scenario: A lowered quota binds that organization only
      When the operator sets the "projectsPerOrg" quota of Ada's organization to 1
      Then the request succeeds
      When Ada tries to create a second project
      Then the request is refused as "quota_exceeded"
      And the refusal names the quota "projectsPerOrg"
      When Grace tries to create a second project
      Then the request succeeds

    Scenario: An override of 0 lifts the quota
      Given the operator has set the "projectsPerOrg" quota of Ada's organization to 1
      When the operator sets the "projectsPerOrg" quota of Ada's organization to 0
      And Ada tries to create a second project
      Then the request succeeds

    Scenario: Removing an override restores the service's default
      Given the operator has set the "projectsPerOrg" quota of Ada's organization to 1
      When the operator removes the "projectsPerOrg" override of Ada's organization
      Then the request succeeds
      And Ada's organization has no quota overrides
      And the "projectsPerOrg" quota of Ada's organization is the same as Grace's

    Scenario: Overrides are kept one by one
      Given the operator has set the "projectsPerOrg" quota of Ada's organization to 3
      When the operator sets the "fleetsPerOrg" quota of Ada's organization to 7
      And Ada looks at her organization's usage
      Then the usage report shows these limits:
        | projectsPerOrg | 3 |
        | fleetsPerOrg   | 7 |

    Scenario: A lowered monthly request quota stops the organization's fleets at once
      When the operator sets the "requestsPerMonth" quota of Ada's organization to 1
      And SDKs send 2 emails through "Staging"
      Then the request is refused as "quota_exceeded"
      And the refusal names the quota "requestsPerMonth"

    Scenario: A lowered state quota applies to the organization's emulators
      When the operator sets the "stateBytes" quota of Ada's organization to 2000
      And an SDK sends an oversized email through "Staging"
      Then the request is refused as "state_too_large"

    Scenario: A lowered fleet budget applies to the organization's fleets
      When the operator sets the "fleetRequestsPerMinute" quota of Ada's organization to 6
      And an SDK calls "Staging" until refused
      Then the request is refused as "fleet_rate_limited"
      And the refusal reports a budget of 6 per minute with nothing remaining

    Scenario Outline: An override of <value> for "<quota>" is rejected
      When the operator tries to set the "<quota>" quota of Ada's organization to <value>
      Then the response status is 400
      And the request is refused as "invalid_request"

      Examples:
        | quota          | value |
        | projectsPerOrg | -1    |
        | projectsPerOrg | 1.5   |
        | projectsPerOrg | "ten" |
        | madeUpQuota    | 5     |

    Scenario: An organization that does not exist cannot be changed
      When the operator sets a quota of an organization that does not exist
      Then the response status is 404
      And the request is refused as "not_found"

  Rule: A suspended organization is not served and cannot change anything

    Background:
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And an SDK has sent an email through "Staging"
      And the operator has suspended Ada's organization for "unpaid invoice"

    Scenario: Its fleets answer that the organization is suspended, and why
      When an SDK sends an email through "Staging"
      Then the response status is 403
      And the request is refused as "org_suspended"
      And the message says "unpaid invoice"

    Scenario: Its members can still read
      When Ada looks at the fleet "Staging"
      Then the request succeeds
      When Ada looks at her organization's usage
      Then the request succeeds
      And the usage report says the organization is suspended for "unpaid invoice"

    Scenario Outline: Its members cannot <change>
      When Ada tries to <change>
      Then the response status is 403
      And the request is refused as "org_suspended"
      And the message says "unpaid invoice"

      Examples:
        | change                             |
        | create a second project            |
        | create a second fleet              |
        | add a second emulator to "Staging" |
        | rename the fleet "Staging"         |
        | reset the emulator of "Staging"    |
        | create an API key                  |
        | invite a person                    |

    Scenario: Its members can still delete
      When Ada deletes the fleet "Staging"
      Then the request succeeds
      And object storage holds nothing for "Staging"

    Scenario: Its members can still delete the organization itself
      When Ada deletes her organization
      Then the request succeeds

    Scenario: Another organization is served as usual
      Given Grace has an open fleet "Preview" with a buffered Resend emulator
      When an SDK sends an email through "Preview"
      Then the email is accepted

    Scenario: Reinstating the organization restores everything
      When the operator reinstates Ada's organization
      Then the request succeeds
      When an SDK sends an email through "Staging"
      Then the email is accepted
      When Ada tries to create a second project
      Then the request succeeds

    Scenario: The operator's list shows the suspension and its reason
      When the operator lists every organization
      Then the list shows Ada's organization as suspended for "unpaid invoice"

  Rule: A suspension reaches every replica within a few seconds

    Background:
      Given a deployment of its own for this scenario
      And a second replica is running
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      And the second replica is already serving "Staging"

    Scenario: A replica that did not handle the suspension stops serving the fleet
      When the operator suspends Ada's organization for "abuse"
      Then within 10 seconds the second replica refuses "Staging" as "org_suspended"

    Scenario: A replica that did not handle the reinstatement serves the fleet again
      Given the operator has suspended Ada's organization for "abuse"
      And within 10 seconds the second replica refuses "Staging" as "org_suspended"
      When the operator reinstates Ada's organization
      Then within 10 seconds the second replica serves "Staging" again
