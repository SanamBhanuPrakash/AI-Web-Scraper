import { useCallback, useEffect, useReducer, useRef } from 'react';
import { SummarizeFailure, summarizeStream, type SummarizeParams } from '../lib/api';
import { initialState, reducer, type State } from '../lib/state';

export interface UseSummarize {
  state: State;
  run: (params: SummarizeParams) => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * Owns one in-flight summary at a time. Starting a new one aborts the previous; events from an
 * aborted run can never reach the UI (guarded by a run id as well as the AbortSignal).
 */
export function useSummarize(fetchImpl?: typeof fetch): UseSummarize {
  const [state, dispatch] = useReducer(reducer, initialState);
  const controller = useRef<AbortController | null>(null);
  const runId = useRef(0);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(
    (params: SummarizeParams) => {
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;
      const id = ++runId.current;
      dispatch({ type: 'start', request: params });

      void summarizeStream(
        params,
        (event) => {
          if (runId.current === id) dispatch({ type: 'event', event });
        },
        ac.signal,
        fetchImpl,
      ).catch((err: unknown) => {
        if (runId.current !== id || ac.signal.aborted) return;
        const failure =
          err instanceof SummarizeFailure
            ? err.info
            : {
                code: 'bad_response' as const,
                message: 'Something unexpected went wrong. Try again.',
                retryable: true,
              };
        dispatch({ type: 'fail', failure });
      });
    },
    [fetchImpl],
  );

  const cancel = useCallback(() => {
    runId.current++;
    controller.current?.abort();
    dispatch({ type: 'cancel' });
  }, []);

  const reset = useCallback(() => {
    runId.current++;
    controller.current?.abort();
    dispatch({ type: 'reset' });
  }, []);

  return { state, run, cancel, reset };
}
