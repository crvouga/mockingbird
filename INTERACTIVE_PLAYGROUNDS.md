# Interactive Playgrounds: Client-Side Toy Apps

Every service now has a **runnable, interactive playground** embedded directly in the documentation. No backend, no external services—everything runs in your browser.

## What You Get

Each service page (e.g., `/service/stripe`) includes:

### Live Demo Section
```
┌─ Live Demo ─────────────────────────────────────┐
│                                                  │
│  Code                    │  Output              │
│  (example code)          │  (results)           │
│                          │                      │
│  ▶ Run Example           │  ✓ Created customer │
│                          │  ✓ Added payment     │
│                          │  ✓ Charge succeeded  │
└──────────────────────────────────────────────────┘
```

**Features:**
- **Code editor** — shows the example code
- **Output pane** — live results as code executes
- **Run button** — execute the example
- **Copy button** — copy code to clipboard
- **Auto-run** — runs automatically on page load

## How It Works

### 1. In-Process Execution

Code runs entirely in your browser using mock objects:

```javascript
// User's code
const stripe = new StripeAPI();
const customer = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    body: "email=user@example.com",
  })
);

// Result shows in real-time
// ✓ POST /v1/customers
// ✓ Created customer: cus_1000
// { id: "cus_1000", email: "user@example.com", ... }
```

### 2. Mock State

Each playground maintains isolated, in-memory state:

```
Playground 1 (Stripe)     Playground 2 (Junction)
├─ customers: {}          ├─ users: {}
├─ charges: {}            ├─ orders: {}
└─ payments: {}           └─ tests: {}
```

State is **isolated per playground** — running one example doesn't affect another.

### 3. Output Capture

Every action is logged:

```
✓ Creating customer...
  ✓ Customer created: cus_1000
✓ Adding payment method...
  ✓ Payment method attached: pm_1000
✓ Processing charge...
  ✓ Charge succeeded: ch_1000

✓ Payment processed
  Amount: $10.00 USD
  Customer: user@example.com
```

## Interactive Elements

### Run Example Button

Click to execute the code. While running:
- Button shows "loading" state
- Output updates in real-time
- Errors are caught and displayed

### Copy Button

Copies the example code to clipboard. Great for:
- Testing locally with `npx mockingbird-service-stripe`
- Integrating into your own code
- Sharing examples with teammates

### Output Pane

Shows:
- Method calls (`POST /v1/customers`)
- Success messages (`✓ Created customer: cus_1000`)
- Parsed results (JSON output)
- Errors with stack traces

## Use Cases

### 1. Quick Demo

New to a service? Click "Run Example" to see it work instantly:

```
Stripe (click Run)
  → Output shows customer creation, payment, charge processing
  → All in-process, no network

Junction (click Run)
  → Output shows user creation, lab test ordering
  → Zero dependencies
```

### 2. Copy & Adapt

See an example you like? Copy the code and modify it:

```typescript
// Copied from playground
const stripe = new StripeAPI();
const customer = await stripe.fetch(...);

// Modify for your use case
const customer = await stripe.fetch(
  new Request(..., {
    body: "email=myteam@company.com&name=My Team",
  })
);
```

### 3. Understand the Behavior

Step through an example in the playground, watch output, understand:
- What the API returns
- What state gets created
- How pagination works
- How errors are formatted

## Toy Apps (Coming Soon)

Beyond simple examples, future versions will include complete toy apps:

### Stripe Checkout Flow

```
Form: Email, Amount
Click "Process Payment"

Output:
1. Creating customer... ✓ cus_1000
2. Adding payment method... ✓ pm_1000
3. Creating charge... ✓ ch_1000
✓ Payment processed: $10.00
```

### Junction Lab Order Flow

```
Form: Patient name, test type
Click "Order Test"

Output:
1. Creating user... ✓ user_1000
2. Ordering lab test... ✓ test_1000
✓ Lab test ordered for Jane Doe
Status: Pending results
```

### Contact Manager (CRM)

```
Form: Name, email, phone
Click "Add Contact"

Output:
✓ Contact created: contact_1000
Contacts: 1
  - Jane Doe (jane@example.com)
```

## Technical Details

### Architecture

```
Service Page (Astro)
├─ Playground component (Astro island)
│  ├─ HTML UI
│  └─ Client-side JS (runs in browser)
│     ├─ Mock service handlers
│     ├─ In-memory state
│     └─ Output capture
```

### Mock Objects

Each service provides simple in-memory mocks:

```typescript
// Stripe mock
fetch(request) {
  if (request.url.includes("/customers")) {
    // Create customer, return response
  }
  if (request.url.includes("/charges")) {
    // Process charge, return response
  }
}
```

**Not a full implementation**, but realistic enough to:
- Show API behavior
- Demonstrate state management
- Handle common workflows

### Performance

- **Lightweight:** No large dependencies
- **Fast:** In-process execution, no latency
- **Responsive:** Results appear instantly
- **Works offline:** No network needed

## Limitations & Future Work

### Current

- Simple mock implementations (don't cover every edge case)
- Output is text-based (not interactive)
- Single example per service (not a full tutorial)

### Future Enhancements

1. **Multi-step workflows** — guide users through common patterns
2. **Interactive output** — click results to inspect details
3. **Customizable inputs** — forms for different API calls
4. **State inspector** — see full mock state after execution
5. **Error cases** — show what happens with invalid inputs
6. **Side-by-side comparison** — run two examples simultaneously
7. **Local data persistence** — save state between refreshes

## For Service Authors

When creating examples in your README, keep them **runnable in the playground**:

✅ **Good:**
```typescript
import { MyAPI } from "@crvouga/mockingbird-service-myservice";

const api = new MyAPI();
const res = await api.fetch(
  new Request("https://api.myservice.com/v1/resource", {
    method: "POST",
    body: JSON.stringify({ name: "example" }),
  })
);
console.log(await res.json());
```

❌ **Problematic:**
```typescript
// Uses real network
const api = axios.create({ baseURL: "https://api.real.com" });

// Uses local files
const fs = require("fs");
fs.readFile(...);

// Uses environment variables
const token = process.env.API_KEY;
```

Keep it:
- Pure (no side effects beyond state mutations)
- Synchronous or async-only (no complex event handlers)
- Self-contained (no external dependencies)
- Realistic (shows real API usage)

## Architecture: Playground Component

```astro
<!-- Playground.astro -->
<div class="playground-container">
  <div class="playground-editor">
    {code}
  </div>
  <div class="playground-output" id="output" />
</div>

<script>
  // On "Run" click:
  1. Clear output
  2. Create mock context (fetch, createAPI, etc.)
  3. Inject console.log capture
  4. eval(userCode)
  5. Display output in real-time
</script>
```

**Key idea:** User's code runs in an `eval()` with injected mock context, captured output, and error handling.

## Example: Stripe Playground

HTML:
```html
<button id="run">▶ Run Example</button>
<div id="output">
  <div class="line success">✓ Created customer: cus_1000</div>
  <div class="line success">✓ Charge succeeded: ch_1000</div>
</div>
```

JavaScript:
```javascript
document.getElementById("run").onclick = async () => {
  const mockState = { customers: {}, charges: {} };
  
  const code = `
    const stripe = new StripeAPI();
    const customer = await stripe.fetch(...);
    console.log("Created:", customer.id);
  `;
  
  eval(code);  // Runs with injected context
};
```

## Key Principles

1. **Zero Infrastructure** — no backend needed
2. **Isomorphic Examples** — works in Node, browsers, Workers
3. **In-Process Execution** — instant feedback
4. **Isolated State** — each playground is independent
5. **Complete Workflows** — show real patterns, not just snippets
6. **Copy-Friendly** — users can copy and run locally

## Summary

Interactive playgrounds make Mockingbird docs:
- **Immediately runnable** — no setup, no downloads
- **Visually clear** — see API behavior in action
- **Trustworthy** — verify the mock before using it
- **Educational** — learn by doing, not just reading

Every service page is now an interactive tutorial.
