import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Keyboard modality for the focus ring (see styles.css): on after a key, off after any pointer use.
const root = document.documentElement;
window.addEventListener("keydown", (e) => {
  if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") root.setAttribute("data-kbd", "");
}, true);
window.addEventListener("pointerdown", () => root.removeAttribute("data-kbd"), true);

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
