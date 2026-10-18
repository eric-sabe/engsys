// exit-after-flush.mjs — exit a CLI only once stdout and stderr have drained.
//
// process.exit() right after a large write to a pipe drops the tail on a loaded host (and always above the
// pipe buffer for 2 MB or so), which truncates what a `$(...)` or a pipeline reads (engsys#198). Writing an
// empty chunk with a callback queues behind everything already written.
export function exitAfterFlush(code = 0) {
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
}
