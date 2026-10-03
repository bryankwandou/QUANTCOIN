import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
import { createRoot } from "react-dom/client";
import "./styles.css";
import { chromeKV, hydrate, syncStorage } from "./storage";
import { useStorage } from "@app/store";
import { OWNER_KEY } from "./owner";
import { RPC_KEY } from "./rpc";
import App from "./App";

const VAULTS_KEY = "quantum-safe/vaults/v1";   // same key as app/src/lib/store.ts
if (new URLSearchParams(location.search).has("tab")) document.body.classList.add("tab");
hydrate(chromeKV(), [VAULTS_KEY, OWNER_KEY, RPC_KEY]).then(() => {
  useStorage(syncStorage);
  createRoot(document.getElementById("root")!).render(<App />);
});
