import { EmptyState } from "@crvouga/mockingbird-ui/react"
import { Pencil, Plus } from "@gravity-ui/icons"
import { Alert, Button, Chip, Form, Modal, Pagination } from "@heroui/react"
import { useState } from "react"
import {
  DataTable,
  ErrorNotice,
  Refresh,
  SearchSelect,
  Section,
  TextInput,
  useAction,
  useChrome,
  usePortal,
  useResource,
  ViewTitle,
} from "./components.js"
import type { Api, StatePage, StateRecord, StateView } from "./model.js"
import { pretty, recordRow } from "./model.js"

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
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="journal-and-state"
        description="The records the emulator holds in this namespace, by collection."
        actions={<Refresh loading={shape.loading} onClick={shape.reload} />}
      >
        State
      </ViewTitle>
      <ErrorNotice error={shape.error} retry={shape.reload} />
      <SearchSelect
        label="Collection"
        ariaLabel="Collection"
        placeholder="Choose a collection"
        value={collection?.name ?? null}
        onChange={setSelection}
        choices={collections.map((item) => ({
          value: item.name,
          label: `${item.label} (${item.count})`,
        }))}
        className="w-full max-w-md"
      />
      {!shape.loading && !shape.error && !collection && (
        <EmptyState
          title="No collections in this namespace"
          description="Records appear here once the emulator stores something."
        />
      )}
      {collection && (
        <Section
          title={collection.label}
          description={collection.description}
          actions={<Chip size="sm">{collection.source}</Chip>}
        >
          <div className="flex flex-wrap gap-1.5">
            {collection.fields.map((field) => (
              <Chip key={field.name} size="sm" variant="secondary" className="font-mono">
                {field.name}: {field.kind}
                {field.optional ? "?" : ""}
              </Chip>
            ))}
          </div>
          <Records
            key={collection.name}
            api={api}
            collection={collection.name}
            sql={sql}
            revision={revision}
          />
        </Section>
      )}
    </div>
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
  const rows = records.map(recordRow)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {sql ? (
          <Alert status="accent" className="flex-1">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Browse records here; use the SQL view to change database rows.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <Button onPress={() => setEditor("new")}>
            <Plus className="size-4" />
            New record
          </Button>
        )}
        <Refresh loading={resource.loading} onClick={resource.reload} />
      </div>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      <DataTable
        label={`${collection} records`}
        rows={rows}
        rowKeys={records.map((record) => record.id)}
        loading={resource.loading}
        pagination={false}
        {...(sql
          ? {}
          : {
              action: (_: Record<string, unknown>, index: number) => (
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${records[index]?.id}`}
                  onPress={() => setEditor(records[index] ?? null)}
                >
                  <Pencil className="size-4" />
                </Button>
              ),
            })}
      />
      <Pagination size="sm" className="flex flex-wrap items-center gap-3">
        <Pagination.Summary>
          Page {page + 1} · {resource.data?.count ?? 0} records
        </Pagination.Summary>
        <Pagination.Content>
          <Pagination.Item>
            <Pagination.Previous
              isDisabled={page === 0 || resource.loading}
              onPress={() => setPage(page - 1)}
            >
              <Pagination.PreviousIcon />
              Previous
            </Pagination.Previous>
          </Pagination.Item>
          <Pagination.Item>
            <Pagination.Next
              isDisabled={resource.data?.next == null || resource.loading}
              onPress={() => {
                const next = resource.data?.next
                if (next == null) return
                setCursors((values) => [...values.slice(0, page), next])
                setPage(page + 1)
              }}
            >
              Next
              <Pagination.NextIcon />
            </Pagination.Next>
          </Pagination.Item>
        </Pagination.Content>
      </Pagination>
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
    </div>
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
  const portal = usePortal()
  const { notify, confirm } = useChrome()
  const editing = record !== "new"
  const [id, setId] = useState(editing ? record.id : "")
  const [value, setValue] = useState(editing ? pretty(record.value) : "{}")
  const action = useAction(api, () => {
    notify("Record saved")
    refresh()
    close()
  })
  const deleting = useAction(api, () => {
    notify("Record deleted")
    refresh()
    close()
  })
  const save = async () => {
    const parsed: unknown = JSON.parse(value)
    await action.run(
      editing ? "PUT" : "POST",
      editing ? `${base}/${encodeURIComponent(record.id)}` : base,
      editing ? { value: parsed } : { ...(id.trim() ? { id: id.trim() } : {}), value: parsed },
    )
  }
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) close()
      }}
      {...portal}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{editing ? "Edit record" : "New record"}</Modal.Heading>
          </Modal.Header>
          <Form
            id="mockingbird-record-editor"
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Modal.Body className="flex flex-col gap-4">
              <ErrorNotice error={action.error ?? deleting.error} />
              <TextInput
                label="Record ID"
                name="id"
                value={id}
                onChange={setId}
                isDisabled={editing}
                {...(editing ? {} : { description: "Leave blank to generate an ID" })}
              />
              <TextInput
                label="JSON value"
                name="value"
                rows={12}
                monospace
                value={value}
                onChange={setValue}
                isRequired
                validate={(text) => {
                  try {
                    JSON.parse(text)
                    return null
                  } catch {
                    return "Enter valid JSON"
                  }
                }}
              />
            </Modal.Body>
            <Modal.Footer className="flex flex-wrap justify-between gap-2">
              {editing ? (
                <Button
                  variant="danger-soft"
                  isPending={deleting.busy}
                  onPress={() =>
                    confirm({
                      title: "Delete this record?",
                      content: record.id,
                      okText: "Delete record",
                      danger: true,
                      onOk: () =>
                        deleting.run("DELETE", `${base}/${encodeURIComponent(record.id)}`),
                    })
                  }
                >
                  Delete record
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="tertiary" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" isPending={action.busy}>
                  Save
                </Button>
              </div>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
