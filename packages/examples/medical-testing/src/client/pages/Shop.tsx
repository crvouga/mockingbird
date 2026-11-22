import { EmptyState, ErrorState, LoadingState, PageHeader } from "@crvouga/mockingbird-ui/react"
import { ArrowRight, Check, Magnifier, Plus, ShoppingCart, Xmark } from "@gravity-ui/icons"
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Label,
  SearchField,
  Separator,
  Table,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import { useState } from "react"
import { api } from "../api.js"
import { message, price, useResource } from "../components/States.js"

const ALL = "All tests"

/** The test catalog: search, categories, and the order being put together. */
export const Shop = ({ onCheckout }: { onCheckout: (checkoutSessionId: string) => void }) => {
  const resource = useResource(api.tests)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState(ALL)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [consent, setConsent] = useState(false)
  const tests = resource.data?.tests ?? []
  const categories = [ALL, ...new Set(tests.map((test) => test.category))]
  const filtered = tests.filter(
    (test) =>
      (category === ALL || test.category === category) &&
      `${test.name} ${test.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const cart = tests.filter((test) => selected.has(test.id))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const checkout = async () => {
    if (pending || !consent || !selected.size) return
    setError(null)
    setPending(true)
    try {
      onCheckout((await api.checkout([...selected])).checkoutSessionId)
    } catch (error) {
      setError(message(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div>
      <PageHeader
        eyebrow="Test catalog"
        title="Find your next test"
        description="Choose individual tests or combine panels. Clear pricing, all in one order."
        actions={
          <Chip variant="soft">
            <Chip.Label>{tests.length} available tests</Chip.Label>
          </Chip>
        }
      />
      <div className="flex flex-col gap-4">
        {resource.error ? (
          <ErrorState
            error={resource.error}
            onRetry={() => void resource.refresh()}
            retryLabel="Try again"
          />
        ) : null}
        {error ? (
          <Alert status="danger" role="alert" data-testid="checkout-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Checkout could not start</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="danger-soft"
                  isDisabled={pending}
                  onPress={() => void checkout()}
                >
                  Retry checkout
                </Button>
              </div>
            </Alert.Content>
          </Alert>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="flex min-w-0 flex-col gap-4" aria-label="Catalog">
            <SearchField value={query} onChange={setQuery}>
              <Label>Search catalog</Label>
              <SearchField.Group>
                <SearchField.SearchIcon>
                  <Magnifier />
                </SearchField.SearchIcon>
                <SearchField.Input
                  placeholder="Search tests or biomarkers…"
                  data-testid="catalog-search"
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <ToggleButtonGroup
              aria-label="Test categories"
              size="sm"
              isDetached
              className="flex-wrap justify-start"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[category]}
              onSelectionChange={(keys) => {
                const [next] = [...keys]
                if (typeof next === "string") setCategory(next)
              }}
            >
              {categories.map((item) => (
                <ToggleButton key={item} id={item} data-testid="category">
                  {item}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {!resource.data && resource.busy ? (
              <LoadingState label="Loading the test catalog…" />
            ) : filtered.length ? (
              <>
                <Table>
                  <Table.ScrollContainer>
                    <Table.Content aria-label="Lab tests">
                      <Table.Header>
                        <Table.Column isRowHeader>Test</Table.Column>
                        <Table.Column className="max-sm:hidden">Category</Table.Column>
                        <Table.Column className="text-end max-sm:hidden">Price</Table.Column>
                        <Table.Column className="text-end">Order</Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {filtered.map((test) => {
                          const added = selected.has(test.id)
                          return (
                            <Table.Row
                              key={test.id}
                              id={test.id}
                              data-testid="test-row"
                              data-test-name={test.name}
                            >
                              <Table.Cell className="min-w-40 sm:min-w-56">
                                <span className="block font-medium text-foreground">
                                  {test.name}
                                </span>
                                <span className="block text-sm text-muted">{test.description}</span>
                                <span className="mt-1 block text-xs text-muted">
                                  At-home collection · Kit included
                                </span>
                                <span className="mt-1 block text-sm font-medium text-foreground sm:hidden">
                                  {price(test.priceCents)} · {test.category}
                                </span>
                              </Table.Cell>
                              <Table.Cell className="whitespace-nowrap text-muted max-sm:hidden">
                                {test.category}
                              </Table.Cell>
                              <Table.Cell className="whitespace-nowrap text-end font-medium max-sm:hidden">
                                {price(test.priceCents)}
                              </Table.Cell>
                              <Table.Cell className="text-end">
                                <ToggleButton
                                  size="sm"
                                  isSelected={added}
                                  isDisabled={pending}
                                  onChange={() => toggle(test.id)}
                                  data-testid="add-test"
                                >
                                  {added ? (
                                    <Check className="size-4" />
                                  ) : (
                                    <Plus className="size-4" />
                                  )}
                                  {added ? "Added" : "Add test"}
                                </ToggleButton>
                              </Table.Cell>
                            </Table.Row>
                          )
                        })}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
                <p className="text-sm text-muted">
                  Every order includes a collection kit. Follow the instructions supplied with your
                  kit, then track processing and read your reports in your account.
                </p>
              </>
            ) : !resource.error ? (
              <Card data-testid="catalog-empty">
                <EmptyState
                  icon={<Magnifier />}
                  title="No tests found"
                  description="Try a different search or category."
                  action={
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setQuery("")
                        setCategory(ALL)
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </Card>
            ) : null}
          </section>
          <Card className="lg:sticky lg:top-20" data-testid="cart">
            <Card.Header className="flex-row items-center justify-between gap-2">
              <Card.Title>Your order</Card.Title>
              <Chip size="sm" variant="soft">
                <Chip.Label>{cart.length}</Chip.Label>
              </Chip>
            </Card.Header>
            {cart.length ? (
              <>
                <Card.Content className="gap-3">
                  {cart.map((test) => (
                    <div key={test.id} className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{test.name}</p>
                        <p className="text-sm text-muted">{price(test.priceCents)}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        isDisabled={pending}
                        aria-label={`Remove ${test.name}`}
                        onPress={() => toggle(test.id)}
                      >
                        <Xmark className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Separator />
                  <div className="flex justify-between text-sm text-muted">
                    <span>Collection kits</span>
                    <span>Included</span>
                  </div>
                  <div className="flex justify-between font-semibold text-foreground">
                    <span>Total</span>
                    <span>{price(cart.reduce((sum, test) => sum + test.priceCents, 0))}</span>
                  </div>
                  <Checkbox isSelected={consent} isDisabled={pending} onChange={setConsent}>
                    <Checkbox.Content data-testid="order-consent">
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Label>
                        I understand this is a demonstration order with fictional results.
                      </Label>
                    </Checkbox.Content>
                  </Checkbox>
                </Card.Content>
                <Card.Footer className="flex-col items-stretch gap-2">
                  <Button
                    fullWidth
                    data-testid="checkout-continue"
                    isDisabled={pending || !consent}
                    onPress={() => void checkout()}
                  >
                    {pending ? "Preparing checkout…" : "Continue to checkout"}
                    <ArrowRight className="size-4" />
                  </Button>
                  <p className="text-center text-xs text-muted">
                    Review payment in the next step. No real charges.
                  </p>
                </Card.Footer>
              </>
            ) : (
              <Card.Content>
                <EmptyState
                  icon={<ShoppingCart />}
                  title="Your order is empty"
                  description="Add a test to see your total here."
                />
              </Card.Content>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
