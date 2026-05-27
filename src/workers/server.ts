import { buildApp } from "../services/app.js";
import { runServerLifecycle } from "./runtime/index.js";

const app = buildApp();
const runtime = await runServerLifecycle(app);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    runtime.send({ type: "shutdown", signal });
  });
}
