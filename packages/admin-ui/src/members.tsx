import { PageHeader } from "@crvouga/mockingbird-ui/react"
import { Tabs } from "@heroui/react"
import { useMemo } from "react"
import { createApi } from "./api.js"
import {
  Choose,
  DataTable,
  ErrorNotice,
  Refresh,
  Section,
  useAction,
  useChrome,
  useResource,
} from "./components.js"
import { useRuntime } from "./environment.js"
import type { MembersConfig } from "./model.js"
import { auditTime } from "./model.js"

type Member = {
  id: string
  name: string | null
  email: string | null
  role: string
  provider: string
}
type AdminData = { users: Member[]; audit: Record<string, unknown>[] }

/** Role administration uses the same component system without imposing a service shell. */
export function Members({ config }: { config: MembersConfig }) {
  const runtime = useRuntime()
  const api = useMemo(
    () =>
      createApi(
        {
          adminPrefix: config.apiPrefix,
          adminKeyHeader: "x-mockingbird-admin-key",
        },
        runtime.fetch,
        "default",
        "",
      ),
    [config, runtime],
  )
  const resource = useResource<AdminData>(api, "/admin")
  const { notify, confirm } = useChrome()
  const action = useAction(api, () => {
    resource.reload()
    notify("Member access updated")
  })
  const update = (member: Member, role: string) =>
    confirm({
      title: `Change ${member.name ?? member.email ?? "member"} to ${role}?`,
      content: "Access changes immediately. This action will be recorded in the audit log.",
      okText: "Change role",
      onOk: () => action.run("PATCH", `/admin/users/${encodeURIComponent(member.id)}`, { role }),
    })
  const permissions = [...new Set(Object.values(config.permissions).flat())].map((permission) => ({
    permission,
    ...Object.fromEntries(
      config.roles.map((role) => [role, config.permissions[role]?.includes(permission) ?? false]),
    ),
  }))
  const users = resource.data?.users ?? []
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Administration"
        description="Manage member access and inspect workspace activity."
        actions={<Refresh loading={resource.loading} onClick={resource.reload} />}
      />
      <ErrorNotice error={resource.error ?? action.error} retry={resource.reload} />
      <Tabs aria-label="Administration">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Administration">
            <Tabs.Tab id="members">Members</Tabs.Tab>
            <Tabs.Tab id="permissions">Role permissions</Tabs.Tab>
            <Tabs.Tab id="audit">Audit log</Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="members" className="pt-4">
          <Section title={`Workspace members (${users.length})`}>
            <DataTable
              label="Workspace members"
              rows={users}
              columns={["name", "email", "provider", "role"]}
              rowKeys={users.map((member) => member.id)}
              loading={resource.loading}
              action={(_, index) => {
                const member = users[index]
                return (
                  member && (
                    <Choose
                      ariaLabel={`Role for ${member.name ?? member.email ?? member.id}`}
                      value={member.role}
                      isDisabled={action.busy || member.id === config.currentUserId}
                      onChange={(role) => {
                        if (role !== member.role) update(member, role)
                      }}
                      choices={config.roles.map((role) => ({ label: role, value: role }))}
                      className="w-36"
                    />
                  )
                )
              }}
            />
          </Section>
        </Tabs.Panel>
        <Tabs.Panel id="permissions" className="pt-4">
          <Section title="Permission matrix">
            <DataTable
              label="Permission matrix"
              rows={permissions}
              columns={["permission", ...config.roles]}
            />
          </Section>
        </Tabs.Panel>
        <Tabs.Panel id="audit" className="pt-4">
          <Section
            title="Recent activity"
            description="Latest 100 role changes, reviews, and document downloads."
          >
            <DataTable
              label="Recent activity"
              rows={
                resource.data?.audit.map((event) => ({
                  ...event,
                  createdAt: auditTime(event.createdAt),
                })) ?? []
              }
              columns={["createdAt", "actor", "action", "target"]}
              loading={resource.loading}
            />
          </Section>
        </Tabs.Panel>
      </Tabs>
    </div>
  )
}
