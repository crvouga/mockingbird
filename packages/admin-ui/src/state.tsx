import { EditOutlined, PlusOutlined } from "@ant-design/icons"
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd"
import { useState } from "react"
import { DataTable, ErrorNotice, Refresh, useAction, useResource, ViewTitle } from "./components.js"
import type { Api, StatePage, StateRecord, StateView } from "./model.js"
import { isRecord, pretty } from "./model.js"

export function StateExplorer({
  api,
  sql,
  revision,
}: {
  api: Api
  sql: boolean
  revision: number
}) {
  const shape = useResource<StateView>(api, "/state", revision)
  const [selection, setSelection] = useState("")
  const collections = shape.data?.collections ?? []
  const collection =
    collections.find((item) => item.name === selection) ??
    collections.find((item) => item.count > 0) ??
    collections[0]
  return (
    <Flex vertical gap="large">
      <Flex gap="middle" wrap align="center" justify="space-between">
        <ViewTitle page="journal-and-state">State</ViewTitle>
        <Refresh loading={shape.loading} onClick={shape.reload} />
      </Flex>
      <ErrorNotice error={shape.error} retry={shape.reload} />
      <Select<string>
        aria-label="Collection"
        loading={shape.loading}
        placeholder="Choose a collection"
        value={collection?.name ?? null}
        onChange={setSelection}
        showSearch
        optionFilterProp="label"
        style={{ width: "100%", maxWidth: 460 }}
        options={
          shape.data?.collections.map((item) => ({
            value: item.name,
            label: `${item.label} (${item.count})`,
          })) ?? []
        }
      />
      {!shape.loading && !shape.error && !collection && (
        <Empty description="No collections in this namespace" />
      )}
      {collection && (
        <Card title={collection.label} extra={<Tag>{collection.source}</Tag>}>
          <Flex vertical gap="middle">
            {collection.description && (
              <Typography.Paragraph>{collection.description}</Typography.Paragraph>
            )}
            <Space wrap>
              {collection.fields.map((field) => (
                <Tag key={field.name}>
                  {field.name}: {field.kind}
                  {field.optional ? "?" : ""}
                </Tag>
              ))}
            </Space>
            <Records
              key={collection.name}
              api={api}
              collection={collection.name}
              sql={sql}
              revision={revision}
            />
          </Flex>
        </Card>
      )}
    </Flex>
  )
}

function Records({
  api,
  collection,
  sql,
  revision,
}: {
  api: Api
  collection: string
  sql: boolean
  revision: number
}) {
  const [page, setPage] = useState(0)
  const [cursors, setCursors] = useState<number[]>([])
  const base = `/state/${encodeURIComponent(collection)}`
  const path = `${base}?limit=50${sql ? `&offset=${page * 50}` : page > 0 ? `&after=${cursors[page - 1]}` : ""}`
  const resource = useResource<StatePage>(api, path, revision)
  const [editor, setEditor] = useState<StateRecord | "new" | null>(null)
  const records = resource.data?.records ?? []
  const rows = records.map((record) => ({
    id: record.id,
    ...(isRecord(record.value) ? record.value : { value: record.value }),
  }))
  return (
    <Flex vertical gap="middle">
      <Flex gap="middle" wrap justify="space-between">
        {sql ? (
          <Alert
            type="info"
            showIcon
            title="Browse records here; use the SQL view to change database rows."
          />
        ) : (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor("new")}>
            New record
          </Button>
        )}
        <Refresh loading={resource.loading} onClick={resource.reload} />
      </Flex>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      <DataTable
        rows={rows}
        rowKeys={records.map((record) => record.id)}
        loading={resource.loading}
        pagination={false}
        {...(sql
          ? {}
          : {
              action: (_: Record<string, unknown>, index: number) => (
                <Button
                  icon={<EditOutlined />}
                  aria-label={`Edit ${records[index]?.id}`}
                  onClick={() => setEditor(records[index] ?? null)}
                />
              ),
            })}
      />
      <Flex gap="small" wrap align="center">
        <Button disabled={page === 0 || resource.loading} onClick={() => setPage(page - 1)}>
          Previous
        </Button>
        <Typography.Text>
          Page {page + 1} · {resource.data?.count ?? 0} records
        </Typography.Text>
        <Button
          disabled={resource.data?.next == null || resource.loading}
          onClick={() => {
            const next = resource.data?.next
            if (next == null) return
            setCursors((values) => [...values.slice(0, page), next])
            setPage(page + 1)
          }}
        >
          Next
        </Button>
      </Flex>
      {editor && (
        <RecordEditor
          api={api}
          base={base}
          record={editor}
          close={() => setEditor(null)}
          refresh={() => {
            setPage(0)
            setCursors([])
            resource.reload()
          }}
        />
      )}
    </Flex>
  )
}

function RecordEditor({
  api,
  base,
  record,
  close,
  refresh,
}: {
  api: Api
  base: string
  record: StateRecord | "new"
  close: () => void
  refresh: () => void
}) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<{ id: string; value: string }>()
  const action = useAction(api, () => {
    void message.success("Record saved")
    refresh()
    close()
  })
  const deleting = useAction(api, () => {
    void message.success("Record deleted")
    refresh()
    close()
  })
  const editing = record !== "new"
  const save = async (values: { id: string; value: string }) => {
    const value: unknown = JSON.parse(values.value)
    await action.run(
      editing ? "PUT" : "POST",
      editing ? `${base}/${encodeURIComponent(record.id)}` : base,
      editing ? { value } : { ...(values.id.trim() ? { id: values.id.trim() } : {}), value },
    )
  }
  return (
    <Modal
      open
      title={editing ? "Edit record" : "New record"}
      onCancel={close}
      onOk={() => form.submit()}
      confirmLoading={action.busy}
      destroyOnHidden
      width={720}
    >
      <Flex vertical gap="middle">
        <ErrorNotice error={action.error ?? deleting.error} />
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            id: editing ? record.id : "",
            value: editing ? pretty(record.value) : "{}",
          }}
          onFinish={save}
        >
          <Form.Item
            name="id"
            label="Record ID"
            extra={editing ? undefined : "Leave blank to generate an ID"}
          >
            <Input disabled={editing} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="value"
            label="JSON value"
            rules={[
              { required: true },
              {
                validator: async (_, value: string) => {
                  try {
                    JSON.parse(value)
                  } catch {
                    throw new Error("Enter valid JSON")
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={12} spellCheck={false} />
          </Form.Item>
        </Form>
        {editing && (
          <Button
            danger
            loading={deleting.busy}
            onClick={() => {
              modal.confirm({
                title: "Delete this record?",
                content: record.id,
                onOk: async () => {
                  const ok = await deleting.run(
                    "DELETE",
                    `${base}/${encodeURIComponent(record.id)}`,
                  )
                  if (!ok) throw new Error("Delete failed")
                },
              })
            }}
          >
            Delete record
          </Button>
        )}
      </Flex>
    </Modal>
  )
}
