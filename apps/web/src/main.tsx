import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { applyStoredTheme } from "./lib/theme";
import "./index.css";

// Before the first render: `index.html` ships the dark class, and a stored light
// is the only override, so it has to be written to the document before React
// paints anything.
applyStoredTheme();

const router = createRouter({ routeTree });

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
