/**
 * The panel a held Home tile opens.
 *
 * ## Why a sheet and not a tooltip anchored to the cell
 *
 * A tooltip has to fit somewhere, and on a 390px screen with a 4x2 grid there
 * is no somewhere: a cell in the bottom row has 90px under it, a cell in the
 * trailing column has 40px beside it, and the arrangement that fits one is
 * wrong for the other seven. Worse, the finger that opened it is on top of it.
 * A sheet from the bottom edge is the same shape for every cell, is never
 * under the thumb that summoned it, and is the gesture's own natural direction
 * — you held down, it came up.
 *
 * ## Why the actions are here rather than only in the grid
 *
 * Holding a cell used to mean "rearrange the grid" and nothing else. That is
 * a real feature and it stays reachable two ways: this sheet carries it as a
 * named button, and 更多 still carries the row it always had. What changed is
 * which of the two a hold reaches *first*, and the argument is frequency —
 * people ask "what is in there" many times a day and "where should this tile
 * sit" roughly once. A gesture should land on the common answer and offer the
 * rare one, not the reverse.
 */

import { Button } from './ui'
import { IconChevronRight, IconEdit, IconX } from './icons'
import { useI18n, type TranslationKey } from '../i18n'
import type { TilePreview } from '../core/home/tilePreview'

export function TilePreviewSheet({
  label,
  preview,
  onOpen,
  onArrange,
  onClose,
}: {
  label: string
  preview: TilePreview
  onOpen: () => void
  onArrange: () => void
  onClose: () => void
}) {
  const { t, formatDateTime } = useI18n()

  return (
    <div
      className="tilesheet-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="tilesheet" role="dialog" aria-modal="true" aria-label={label}>
        <div className="tilesheet__grip" aria-hidden="true" />
        <div className="tilesheet__head">
          {/*
            Here the name *is* wanted, and it is not the duplication
            `check:screen-titles` forbids: that rule is about a screen restating
            the control that opened it while that control is gone from view.
            This panel sits over the grid with the pressed cell still visible
            underneath, and it is 60px tall — without a name it is a floating
            list of numbers about nothing.
          */}
          <span className="tilesheet__title">{label}</span>
          <button type="button" className="tilesheet__x" onClick={onClose} aria-label={t('common.close')}>
            <IconX size={17} />
          </button>
        </div>

        {preview.lines.length === 0 ? (
          <p className="tilesheet__empty">{t('preview.none')}</p>
        ) : (
          <dl className="tilesheet__lines" data-quiet={preview.empty || undefined}>
            {preview.lines.map((line) => (
              <div key={line.key} className="tilesheet__line" data-tone={line.tone ?? 'neutral'}>
                <dd className="tilesheet__value">
                  {/*
                    `at` is an instant, and only the component has a locale to
                    format it with — which is the reason `tilePreview.ts` hands
                    over a number as a string rather than a formatted date. A
                    core module that formatted its own timestamps would format
                    them in one language.
                  */}
                  {t(
                    line.key as TranslationKey,
                    line.values?.at !== undefined
                      ? { ...line.values, at: formatDateTime(Number(line.values.at)) }
                      : line.values,
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div className="tilesheet__actions">
          <Button variant="primary" icon={<IconChevronRight size={16} />} onClick={onOpen}>
            {t('preview.open')}
          </Button>
          <Button variant="ghost" icon={<IconEdit size={16} />} onClick={onArrange}>
            {t('home.arrangeOpen')}
          </Button>
        </div>
      </div>
    </div>
  )
}
