/**
 * What an ongoing sync resolved on its own, laid out for a second look.
 *
 * Not a blocking modal — a sync cycle runs on a timer in the background
 * (`core/syncLoop.ts`), and a dialog that popped up demanding a decision the
 * moment two devices happened to edit the same reminder would turn a quiet
 * feature into an interruption. `core/syncConflict.ts`'s `resolveConflicts`
 * already picked the newer side automatically; this is the retroactive
 * confirmation of that choice — a sheet that stays out of the way until
 * someone wants to check it, with "keep mine instead" for the one case where
 * the automatic pick was wrong.
 *
 * `dismissed` is local and unpersisted on purpose: hiding an entry here only
 * clears it from view in *this* session. The underlying rollback snapshot
 * (`AppState.syncConflicts`) stays put until its cap is reached — dismissing
 * is "I have seen this", not "delete the undo".
 */

import { useState } from 'react'
import { Button, Card, CardHeader, EmptyState, useToast } from './ui'
import { IconAlert, IconRefresh } from './icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'

export function SyncConflictList() {
  const { state, restoreSyncConflict } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visible = state.syncConflicts.filter((c) => !dismissed.has(c.id))
  if (visible.length === 0) return null

  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id))

  return (
    <Card>
      <CardHeader title={t('sync.conflict.title')} hint={t('sync.conflict.summary', { n: visible.length })} />
      <div className="card__body form-rows">
        {visible.map((c) => (
          <div key={c.id} className="log" style={{ alignItems: 'center' }}>
            <IconAlert size={16} className="banner__icon" />
            <div className="log__body">
              <div className="log__title">{c.winningSummary}</div>
              <div className="log__detail">
                {t('sync.conflict.keptNewer', { theirs: c.losingSummary })} · {formatDateTime(c.at)}
              </div>
            </div>
            {/* Wrapped so the ≤560px rule has one thing to move onto its own
                line. The label is ~270px in French and `.btn` cannot shrink
                below it, which left `.log__title` — the statement of what the
                conflict actually was — clipped to nothing. */}
            <div className="log__actions">
              <Button
                variant="ghost"
                icon={<IconRefresh size={14} />}
                onClick={() => {
                  restoreSyncConflict(c.id)
                  dismiss(c.id)
                  toast.push({ tone: 'success', title: t('sync.conflict.restored'), detail: c.losingSummary })
                }}
              >
                {t('sync.conflict.keepMineInstead')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Rendered instead when there is nothing to review — used only where the caller wants the empty state spelled out rather than the card vanishing outright (see `DevicesCard.tsx`). */
export function SyncConflictEmpty() {
  const { t } = useI18n()
  return <EmptyState icon={<IconAlert size={20} />} title={t('sync.conflict.none')} />
}
