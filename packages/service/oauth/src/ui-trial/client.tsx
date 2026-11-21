import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import { mount } from "@crvouga/mockingbird-ui/react/client"

export function start(root: HTMLElement, props: { name: string }) {
  mount(root, <CenteredCard title={`Allow ${props.name}?`} product="Google" />)
}
