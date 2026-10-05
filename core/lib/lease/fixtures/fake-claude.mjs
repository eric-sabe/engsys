// fake-claude.mjs: a stand-in claude session process for keepalive-lifetime.test.mjs. It starts a
// watch bus the way a Monitor does (its own process group, so the test can kill the whole group),
// starts another on each SIGUSR1 (a re-armed Monitor), and stays up until it is killed.
// Usage: node fake-claude.mjs <watch-script> <state-dir> <repo> <out-prefix>
//   bus N writes its pid to <out-prefix>-N.pid, its stdout to <out-prefix>-N.out, stderr to -N.err.
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";

const [watch, dir, repo, prefix] = process.argv.slice(2);
let n = 0;
function startBus() {
  n += 1;
  const bus = spawn("bash", [watch, "--repo", repo, "--state-dir", dir, "--interval", "1"], {
    detached: true,
    stdio: ["ignore", openSync(`${prefix}-${n}.out`, "a"), openSync(`${prefix}-${n}.err`, "a")],
  });
  writeFileSync(`${prefix}-${n}.pid`, String(bus.pid));
}
process.on("SIGUSR1", startBus);
startBus();
setInterval(() => {}, 1 << 30);
