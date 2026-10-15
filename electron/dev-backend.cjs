const { spawn } = require("node:child_process");
const path = require("node:path");

const nextCli = path.join(__dirname, "..", "node_modules", "next", "dist", "bin", "next");
const backend = spawn(process.execPath, [nextCli, "dev", "-p", "3001"], {
  cwd: path.join(__dirname, "..", "backend"),
  env: { ...process.env, LITTLE_SUNSHINE_RUNTIME: "desktop" },
  stdio: "inherit",
  windowsHide: true,
});

backend.on("error", (error) => {
  console.error("Could not start the Desktop development backend:", error.message);
  process.exitCode = 1;
});
backend.on("exit", (code, signal) => {
  process.exit(signal ? 0 : code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => backend.kill(signal));
