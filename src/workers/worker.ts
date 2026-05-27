import { buildApp } from "../services/app.js";
import { runWorkerLifecycle } from "./runtime/index.js";

const app = buildApp();
const runtime = await runWorkerLifecycle(app);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    runtime.send({ type: "shutdown", signal });
  });
}
