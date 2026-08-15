/**
 * Move the data folder and repair everything that pointed into the old one —
 * moved out of `AppState.tsx`'s `AppProvider` unchanged, see that file for
 * how this is wired in.
 *
 * The bridge only moves files. The paths recorded inside each scheduled job
 * are ours to fix, and the platform scheduler is holding a copy of those jobs
 * — so it is re-armed here explicitly rather than waiting for the signature
 * effect, which watches fire times and would not notice a path change.
 */

import { useCallback } from 'react'
import type { DataFolderChange, PlatformBridge } from '../../core/platform/bridge'
import type { LogEntry, MailAccount, ScheduledJob, Settings } from '../../core/types'

/** The action shape this hook dispatches — see `AppState.tsx`'s `Action` union for the source of truth. */
type RelocateDispatchAction = { type: 'rebaseAttachments'; from: string; to: string }

export function useRelocateData(
  bridge: PlatformBridge | null,
  jobs: ScheduledJob[],
  accounts: MailAccount[],
  settings: Settings,
  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void,
  dispatch: (action: RelocateDispatchAction) => void,
): (change: DataFolderChange, previousPath: string) => Promise<void> {
  return useCallback(
    async (change: DataFolderChange, previousPath: string) => {
      if (!change.changed || !change.moved) return
      const from = previousPath
      const to = change.path
      if (!from || from === to) return

      dispatch({ type: 'rebaseAttachments', from, to })

      const rebase = (p: string) => (p.startsWith(from) ? to + p.slice(from.length) : p)
      const repaired = jobs
        .filter((j) => j.enabled)
        .map((job) => ({
          ...job,
          draft: {
            ...job.draft,
            attachments: job.draft.attachments.map((a) =>
              a.source === 'copy' ? { ...a, path: rebase(a.path) } : a,
            ),
          },
        }))
      try {
        await bridge?.syncJobs(repaired, accounts, {
          notifyOnSuccess: settings.notifyOnSuccess,
          notifyOnFailure: settings.notifyOnFailure,
          localDeviceId: settings.localDeviceId,
        })
      } catch (e) {
        // The files did move, so the caller reports success and nothing else in
        // this flow would ever mention that the scheduler is still holding
        // paths into the old folder. Left silent, the first symptom is a
        // scheduled send going out hours later with a missing attachment.
        addLog({
          kind: 'schedule',
          level: 'error',
          title: 'Data folder moved, but reminders still point at the old one',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    },
    // Matches the original inline callback's dependency list exactly —
    // `settings` and `dispatch` are read inside but were not (and still are
    // not) listed, so this preserves the exact same memoization behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge, jobs, accounts, addLog],
  )
}
