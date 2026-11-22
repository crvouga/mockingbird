import { EmptyState, PageHeader } from "@crvouga/mockingbird-ui/react"
import { ShoppingCart } from "@gravity-ui/icons"
import { Button, Card } from "@heroui/react"
import { useState } from "react"
import { CheckoutModal } from "../components/CheckoutModal.js"
import { navigate } from "../router.js"

/** Secure checkout: the payments provider's hosted page in a modal over this screen. */
export const Checkout = ({
  checkoutSessionId,
  onPaid,
}: {
  checkoutSessionId: string | null
  onPaid: () => void
}) => {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <PageHeader
        eyebrow="Secure checkout"
        title="Checkout"
        description="Pay on the provider's hosted page. No real charges."
      />
      <Card>
        <EmptyState
          icon={<ShoppingCart />}
          title={
            !checkoutSessionId
              ? "No order in progress"
              : open
                ? "Complete payment in the checkout window"
                : "Checkout closed"
          }
          description={
            !checkoutSessionId
              ? "Choose tests from the catalog to start an order."
              : "Your selected tests are saved. You can resume checkout from Orders."
          }
          action={
            <Button
              variant={open && checkoutSessionId ? "secondary" : "primary"}
              onPress={() => navigate("shop")}
            >
              Back to shop
            </Button>
          }
        />
      </Card>
      {checkoutSessionId && open ? (
        <CheckoutModal
          checkoutSessionId={checkoutSessionId}
          onDone={onPaid}
          onClose={() => {
            setOpen(false)
            navigate("shop")
          }}
        />
      ) : null}
    </div>
  )
}
