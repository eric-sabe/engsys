// Tests for run-tests.mjs (engsys#233): worker count, per-suite TMPDIR, serial suites — run by `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, jobCount, runSuites } from "./run-tests.mjs";

const sandbox = () => mkdtempSync(join(tmpdir(), "run-tests-test-"));
const quiet = { write: () => {} };

test("jobCount: min(cores - 1, 6), at least 1; ENGSYS_TEST_JOBS overrides; junk is refused", () => {
  assert.equal(jobCount({}, 12), 6);
  assert.equal(jobCount({}, 4), 3);
  assert.equal(jobCount({}, 1), 1);
  assert.equal(jobCount({ ENGSYS_TEST_JOBS: "" }, 4), 3);
  assert.equal(jobCount({ ENGSYS_TEST_JOBS: "1" }, 12), 1);
  assert.equal(jobCount({ ENGSYS_TEST_JOBS: "20" }, 2), 20);
  for (const bad of ["0", "-1", "2.5", "two", " 3"]) assert.throws(() => jobCount({ ENGSYS_TEST_JOBS: bad }, 4), /positive integer/, bad);
});

test("cleanEnv drops the fleet's variables, including ENGSYS_TEST_JOBS, and keeps the rest", () => {
  assert.deepEqual(cleanEnv({ PATH: "/bin", ENGSYS_TEST_JOBS: "3", FLEET_ID: "x", GH_TOKEN: "t", HOME: "/h" }), { PATH: "/bin", HOME: "/h" });
});

for (const jobs of [1, 4]) {
  test(`jobs=${jobs}: each suite gets its own TMPDIR, removed on pass, kept on failure; results keep list order`, async () => {
    const base = sandbox();
    const seen = sandbox();
    try {
      const suites = [
        { cmd: `echo "$TMPDIR" > "${seen}/a"; touch "$TMPDIR/junk"` },
        { cmd: `echo "$TMPDIR" > "${seen}/b"; touch "$TMPDIR/evidence"; exit 3` },
        { cmd: `echo "$TMPDIR" > "${seen}/c"; node -e 'process.stdout.write(require("os").tmpdir())' > "${seen}/c-node"` },
      ];
      const r = await runSuites(suites, { jobs, env: { PATH: process.env.PATH }, base, ...quiet });
      assert.deepEqual(r.map((x) => x.code), [0, 3, 0]);
      assert.deepEqual(r.map((x) => x.cmd), suites.map((s) => s.cmd));
      const dirs = ["a", "b", "c"].map((k) => readFileSync(join(seen, k), "utf8").trim());
      assert.equal(new Set(dirs).size, 3, "three distinct TMPDIRs");
      for (const d of dirs) assert.ok(d.startsWith(join(base, "engsys-test-")), d);
      assert.equal(readFileSync(join(seen, "c-node"), "utf8"), dirs[2], "node's os.tmpdir() follows it");
      assert.ok(!existsSync(dirs[0]) && !existsSync(dirs[2]), "passing suites' TMPDIRs are removed");
      assert.equal(r[1].tmp, dirs[1]);
      assert.ok(existsSync(join(dirs[1], "evidence")), "the failing suite's TMPDIR is kept, contents and all");
      assert.deepEqual(readdirSync(base), [dirs[1].slice(base.length + 1)]);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(seen, { recursive: true, force: true });
    }
  });
}

test("parallel: output is buffered per suite and printed whole", async () => {
  const base = sandbox();
  try {
    let out = "";
    const suites = [1, 2, 3].map((n) => ({ cmd: `for i in 1 2 3; do echo s${n}-$i; sleep 0.05; done` }));
    await runSuites(suites, { jobs: 3, env: { PATH: process.env.PATH }, base, write: (s) => { out += s; } });
    for (const n of [1, 2, 3]) assert.match(out, new RegExp(`=== [^\\n]*s${n}[^\\n]*\\ns${n}-1\\ns${n}-2\\ns${n}-3\\n`), `suite ${n} printed as one block`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a serial suite runs alone, after the parallel ones", async () => {
  const base = sandbox();
  const log = sandbox();
  try {
    const span = (name, secs) => `echo "start ${name}" >> "${log}/log"; sleep ${secs}; echo "end ${name}" >> "${log}/log"`;
    const suites = [
      { cmd: span("p1", 0.3) },
      { cmd: span("s1", 0.1), serial: "test" },
      { cmd: span("p2", 0.3) },
      { cmd: span("s2", 0.1), serial: "test" },
    ];
    const r = await runSuites(suites, { jobs: 4, env: { PATH: process.env.PATH }, base, ...quiet });
    assert.ok(r.every((x) => x.code === 0));
    const lines = readFileSync(join(log, "log"), "utf8").trim().split("\n");
    assert.deepEqual(lines.slice(4), ["start s1", "end s1", "start s2", "end s2"], lines.join(" | "));
    assert.deepEqual(new Set(lines.slice(0, 2)), new Set(["start p1", "start p2"]), "the parallel ones overlap");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(log, { recursive: true, force: true });
  }
});

test("the same command listed twice keeps a result per occurrence", async () => {
  const base = sandbox();
  const state = sandbox();
  try {
    const cmd = `if [ -e "${state}/ran" ]; then exit 0; else touch "${state}/ran"; exit 1; fi`;
    const r = await runSuites([{ cmd }, { cmd }], { jobs: 1, env: { PATH: process.env.PATH }, base, ...quiet });
    assert.deepEqual(r.map((x) => x.code), [1, 0]);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
