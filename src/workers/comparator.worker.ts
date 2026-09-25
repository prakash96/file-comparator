import { toFriendlyError } from '../models/issues';
import type { ProgressInfo } from '../models/session';
import type { WorkerMessageIn, WorkerMessageOut } from './protocol';
import { ComparatorSession } from './session';

/**
 * Comparator Web Worker. All parsing, comparison, querying and report
 * generation runs here, off the UI thread. It never performs network I/O.
 */
const ctx = self as unknown as { postMessage(m: WorkerMessageOut): void; onmessage: ((e: MessageEvent<WorkerMessageIn>) => void) | null };
const session = new ComparatorSession();

const PROGRESS_INTERVAL_MS = 120;

function progressSender(id: number) {
  let last = 0;
  return (progress: ProgressInfo) => {
    const t = performance.now();
    if (progress.stage !== 'complete' && t - last < PROGRESS_INTERVAL_MS) return;
    last = t;
    ctx.postMessage({ id, kind: 'progress', progress });
  };
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  const reply = (payload: unknown) => ctx.postMessage({ id: msg.id, kind: 'result', payload });
  try {
    switch (msg.type) {
      case 'load':
        reply(await session.load(msg.slot, msg.file, msg.file.name, msg.options, progressSender(msg.id)));
        break;
      case 'clear':
        session.clear(msg.slot);
        reply(null);
        break;
      case 'reset':
        session.reset();
        reply(null);
        break;
      case 'schema':
        reply(session.schema(msg.options));
        break;
      case 'compare':
        reply(session.compare(msg.options, progressSender(msg.id)));
        break;
      case 'query':
        reply(session.query(msg.query));
        break;
      case 'export':
        reply(await session.exportReport(msg.kind, progressSender(msg.id)));
        break;
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, kind: 'error', error: toFriendlyError(err) });
  }
};
