import { runTurn, type TurnRequest } from './runner.ts';
import { applyEvent, failRun, finishRun, redactSecrets } from './translate.ts';
import type { NoticeNode, Op, RunState } from './types.ts';

export interface DrivableRun {
  state: RunState;
  abort: AbortController;
}

export interface DriveHandlers {
  emit: (ops: Op[]) => void;
  end?: (exitCode: number | null, timedOut: boolean) => void;
}

export async function driveRun(run: DrivableRun, req: TurnRequest, handlers: DriveHandlers): Promise<void> {
  const { emit } = handlers;
  let stderr = '';

  try {
    for await (const message of runTurn(req, run.abort.signal)) {
      switch (message.kind) {
        case 'raw':
          emit(applyEvent(run.state, message.event));
          break;

        case 'unparsed': {
          const node: NoticeNode = {
            kind: 'notice',
            id: `raw-${run.state.nodes.length}`,
            parentToolUseId: null,
            seq: run.state.nodes.length,
            level: 'warn',
            text: `unrecognised line on stdout: ${message.text.slice(0, 200)}`,
          };
          run.state.nodes.push(node);
          emit([{ op: 'node', node }]);
          break;
        }

        case 'stderr':
          stderr = redactSecrets(message.text);
          break;

        case 'spawn_error':
          emit(failRun(run.state, message.message));
          break;

        case 'exit':
          if (run.abort.signal.aborted) {
            emit(failRun(run.state, 'run stopped by the user'));
          } else if (message.timedOut) {
            emit(failRun(run.state, 'run timed out'));
          } else if (run.state.status === 'running') {
            if (message.code === 0) emit(finishRun(run.state));
            else emit(failRun(run.state, run.state.error ?? stderr ?? `claude exited with code ${message.code}`));
          } else if (message.code !== 0 && run.state.status === 'finished') {
            emit(failRun(run.state, `claude exited with code ${message.code}`));
          }
          handlers.end?.(message.code, message.timedOut);
          return;
      }
    }
  } catch (error) {
    emit(failRun(run.state, `server error: ${(error as Error).message}`));
    handlers.end?.(null, false);
  }
}
