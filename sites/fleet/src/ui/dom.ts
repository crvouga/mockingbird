/** A hyperscript helper: `h("button.small.danger", { type: "button" }, "Remove")`. */

export type Child = Node | string | false | null | undefined | Child[]
export type Props = Record<string, string | boolean | ((event: Event) => void) | undefined>

export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split(".")
  const element = document.createElement(name || "div")
  if (classes.length > 0) element.className = classes.join(" ")
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(key.slice(2), value)
    else if (value === true) element.setAttribute(key, "")
    else if (typeof value === "string") element.setAttribute(key, value)
  }
  const append = (child: Child) => {
    if (Array.isArray(child)) child.forEach(append)
    else if (child !== false && child !== null && child !== undefined) element.append(child)
  }
  append(children)
  return element
}
