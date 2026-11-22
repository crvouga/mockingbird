import { Table } from "@heroui/react"
import { Empty, Sub } from "../kit.js"
import { api } from "../runtime.js"
import type { Org } from "../types.js"

export async function auditLog(org: Org) {
  const entries = (
    await api<{
      data: { id: string; actor: string; action: string; target: string; at: string }[]
    }>("GET", `/orgs/${org.id}/audit`)
  ).data
  return (
    <section className="flex flex-col gap-4">
      <Sub>The 200 most recent changes, newest first. Entries are kept for 90 days.</Sub>
      {entries.length > 0 ? (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Audit log">
              <Table.Header>
                <Table.Column isRowHeader>Action</Table.Column>
                <Table.Column>By, on</Table.Column>
                <Table.Column>When</Table.Column>
              </Table.Header>
              <Table.Body>
                {entries.map((entry) => (
                  <Table.Row key={entry.id} id={entry.id}>
                    <Table.Cell className="font-mono text-[13px]">{entry.action}</Table.Cell>
                    <Table.Cell className="break-words whitespace-normal">
                      {`${entry.actor.split(":").slice(2).join(":") || entry.actor} on ${entry.target}`}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-muted">
                      {new Date(entry.at).toLocaleString()}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      ) : (
        <Empty title="Nothing has been changed yet." />
      )}
    </section>
  )
}
