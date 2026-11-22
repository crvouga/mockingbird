import { mount } from "@crvouga/mockingbird-ui/react/client";
import { StrictMode } from "react";
import { App } from "./App.tsx";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

mount(
  root,
  <StrictMode>
    <App />
  </StrictMode>,
);
