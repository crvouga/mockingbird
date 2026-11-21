import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { Table } from "@heroui/react"
import { Empty, Section, Sub, Tag } from "../kit.js"
import { api } from "../runtime.js"
import type { Org } from "../types.js"

/** Limit → its label and, when the organization has a running count against it, that count. */
export const LIMIT_LABELS: [string, string, string?][] = [
  ["projectsPerOrg", "Projects", "projects"],
  ["fleetsPerOrg", "Fleets", "fleets"],
  ["membersPerOrg", "Members and pending invites", "members"],
  ["apiKeysPerOrg", "API keys", "apiKeys"],
  ["requestsPerMonth", "Emulator requests this month", "requestsThisMonth"],
  ["emulatorsPerFleet", "Emulators per fleet"],
  ["fleetRequestsPerMinute", "Requests per fleet per minute"],
  ["stateBytes", "Stored state per emulator (bytes)"],
]

export async function usage(org: Org) {
  const report = await api<{
    limits: Record<string, number>
    usage: Record<string, number>
    daily: { day: string; requests: number }[]
  }>("GET", `/orgs/${org.id}/usage`)
  const number = (value: number) => value.toLocaleString()
  return (
    <>
      <section className="flex flex-col gap-4">
        <Sub>
          Limits are set by the operator of this server. Requests are counted per calendar month
          (UTC).
        </Sub>
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Limits">
              <Table.Header>
                <Table.Column isRowHeader>Limit</Table.Column>
                <Table.Column>Used</Table.Column>
              </Table.Header>
              <Table.Body>
                {LIMIT_LABELS.map(([limit, label, used]) => {
                  const max = report.limits[limit] ?? 0
                  const current = used ? (report.usage[used] ?? 0) : undefined
                  const full = current !== undefined && max > 0 && current >= max
                  const text =
                    current === undefined
                      ? max === 0
                        ? "unlimited"
                        : `up to ${number(max)}`
                      : `${number(current)} of ${max === 0 ? "unlimited" : number(max)}`
                  return (
                    <Table.Row key={limit} id={limit}>
                      <Table.Cell className="break-words whitespace-normal">{label}</Table.Cell>
                      <Table.Cell className="text-right">
                        {full ? (
                          <span title="Limit reached">
                            <StatusChip status="warning">{text}</StatusChip>
                          </span>
                        ) : (
                          <Tag>{text}</Tag>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  )
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </section>
      <Section title="Requests per day">
        {report.daily.length > 0 ? (
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Requests per day">
                <Table.Header>
                  <Table.Column isRowHeader>Day (UTC)</Table.Column>
                  <Table.Column>Requests</Table.Column>
                </Table.Header>
                <Table.Body>
                  {[...report.daily].reverse().map((entry) => (
                    <Table.Row key={entry.day} id={entry.day}>
                      <Table.Cell className="font-mono text-[13px]">{entry.day}</Table.Cell>
                      <Table.Cell className="text-right">
                        <Tag>{number(entry.requests)}</Tag>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title="No emulator requests in the last 31 days." />
        )}
      </Section>
    </>
  )
}
