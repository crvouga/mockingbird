/** The browser half of ./server.tsx's pages: the IIFE assigns these to `MockingbirdService`. */
import { mount } from "@crvouga/mockingbird-ui/react/client"
import { FleetConsole, type FleetConsoleProps } from "./fleet-console.js"

export const mountFleetConsole = (root: HTMLElement, props: FleetConsoleProps) =>
  mount(root, <FleetConsole {...props} />)
