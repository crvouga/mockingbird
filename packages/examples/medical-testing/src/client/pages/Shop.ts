import { html } from "htm/preact"
import { useEffect, useMemo, useState } from "preact/hooks"
import { api, type LabTest } from "../api.js"
import { IconDroplet, IconHeartPulse, IconLeaf } from "../components/Icons.js"
import { navigate } from "../router.js"

const CATEGORY_ORDER = ["Popular", "Heart & Metabolic", "Hormones"]
const CATEGORY_ICON: Record<string, () => unknown> = {
  Popular: IconDroplet,
  "Heart & Metabolic": IconHeartPulse,
  Hormones: IconLeaf,
}

const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export const Shop = ({ onCheckout }: { onCheckout: (checkoutSessionId: string) => void }) => {
  const [tests, setTests] = useState<LabTest[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    void api.tests().then((res) => setTests(res.tests))
  }, [])

  const byCategory = useMemo(() => {
    const groups = new Map<string, LabTest[]>()
    for (const test of tests) {
      const list = groups.get(test.category) ?? []
      list.push(test)
      groups.set(test.category, list)
    }
    const ordered = [
      ...CATEGORY_ORDER.filter((c) => groups.has(c)),
      ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
    ]
    return ordered.map((category) => ({ category, tests: groups.get(category) ?? [] }))
  }, [tests])

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const total = tests.filter((t) => selected.has(t.id)).reduce((sum, t) => sum + t.priceCents, 0)

  const checkout = async () => {
    setError(null)
    setPending(true)
    try {
      const result = await api.checkout([...selected])
      onCheckout(result.checkoutSessionId)
      navigate("checkout")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return html`
    <div>
      <h1>Shop lab tests</h1>
      <p class="cove-muted">Pick the panels you want. Ships as an at-home testkit — results land in Orders.</p>
      ${error && html`<p class="cove-alert cove-alert-error">${error}</p>`}

      ${byCategory.map(
        ({ category, tests: items }) => html`
          <div class="cove-category" key=${category}>
            <h2>
              <span class="cove-category-icon"><${CATEGORY_ICON[category] ?? IconDroplet} /></span>
              ${category}
            </h2>
            <div class="cove-test-grid">
              ${items.map(
                (test) => html`
                  <button
                    type="button"
                    class="cove-test-card ${selected.has(test.id) ? "is-selected" : ""}"
                    onClick=${() => toggle(test.id)}
                    key=${test.id}
                  >
                    <div class="cove-test-card-top">
                      <span class="cove-test-name">${test.name}</span>
                      <span class="cove-test-price">${formatPrice(test.priceCents)}</span>
                    </div>
                    <span class="cove-test-desc">${test.description}</span>
                    <span class="cove-eyebrow">${selected.has(test.id) ? "✓ Added" : "+ Add"}</span>
                  </button>
                `,
              )}
            </div>
          </div>
        `,
      )}

      ${
        selected.size > 0 &&
        html`<div class="cove-cart-bar">
        <span>${selected.size} test${selected.size === 1 ? "" : "s"} selected — ${formatPrice(total)}</span>
        <button class="cove-btn cove-btn-accent" disabled=${pending} onClick=${checkout}>
          ${pending ? "Starting checkout…" : "Checkout"}
        </button>
      </div>`
      }
    </div>
  `
}
