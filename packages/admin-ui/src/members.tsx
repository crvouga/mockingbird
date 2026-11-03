import { App, Card, Flex, Select, Tabs, Typography } from "antd"
import { useMemo } from "react"
import { createApi } from "./api.js"
import { DataTable, ErrorNotice, Refresh, useAction, useResource } from "./components.js"
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
  const api = useMemo(
    () =>
      createApi(
        {
          adminPrefix: config.apiPrefix,
          adminKeyHeader: "x-mockingbird-admin-key",
        },
        fetch,
        "default",
        "",
      ),
    [config],
  )
  const resource = useResource<AdminData>(api, "/admin")
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    resource.reload()
    void message.success("Member access updated")
  })
  const update = (member: Member, role: string) =>
    modal.confirm({
      title: `Change ${member.name ?? member.email ?? "member"} to ${role}?`,
      content: "Access changes immediately. This action will be recorded in the audit log.",
      okText: "Change role",
      onOk: async () => {
        if (!(await action.run("PATCH", `/admin/users/${encodeURIComponent(member.id)}`, { role })))
          throw new Error("Role change failed")
      },
    })
  const permissions = [...new Set(Object.values(config.permissions).flat())].map((permission) => ({
    permission,
    ...Object.fromEntries(
      config.roles.map((role) => [role, config.permissions[role]?.includes(permission) ?? false]),
    ),
  }))
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between" align="center">
        <div>
          <Typography.Title level={2} style={{ margin: "0 0 8px" }}>
            Administration
          </Typography.Title>
          <Typography.Text type="secondary">
            Manage member access and inspect workspace activity.
          </Typography.Text>
        </div>
        <Refresh loading={resource.loading} onClick={resource.reload} />
      </Flex>
      <ErrorNotice error={resource.error ?? action.error} retry={resource.reload} />
      <Tabs
        items={[
          {
            key: "members",
            label: "Members",
            children: (
              <Card title={`Workspace members (${resource.data?.users.length ?? 0})`}>
                <DataTable
                  rows={resource.data?.users ?? []}
                  columns={["name", "email", "provider", "role"]}
                  rowKeys={resource.data?.users.map((member) => member.id) ?? []}
                  loading={resource.loading}
                  actionWidth={180}
                  action={(_, index) => {
                    const member = resource.data?.users[index]
                    return (
                      member && (
                        <Select
                          aria-label={`Role for ${member.name ?? member.email ?? member.id}`}
                          value={member.role}
                          disabled={action.busy || member.id === config.currentUserId}
                          style={{ width: 150 }}
                          options={config.roles.map((role) => ({ label: role, value: role }))}
                          onChange={(role) => update(member, role)}
                        />
                      )
                    )
                  }}
                />
              </Card>
            ),
          },
          {
            key: "permissions",
            label: "Role permissions",
            children: (
              <Card title="Permission matrix">
                <DataTable rows={permissions} columns={["permission", ...config.roles]} />
              </Card>
            ),
          },
          {
            key: "audit",
            label: "Audit log",
            children: (
              <Card title="Recent activity">
                <Typography.Paragraph type="secondary">
                  Latest 100 role changes, reviews, and document downloads.
                </Typography.Paragraph>
                <DataTable
                  rows={
                    resource.data?.audit.map((event) => ({
                      ...event,
                      createdAt: auditTime(event.createdAt),
                    })) ?? []
                  }
                  columns={["createdAt", "actor", "action", "target"]}
                  loading={resource.loading}
                />
              </Card>
            ),
          },
        ]}
      />
    </Flex>
  )
}
