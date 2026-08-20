import { useState } from 'react'
import { VirtualList } from '../components/VirtualList'
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHead,
  useConfirm,
  useToast,
} from '../components/ui'
import { IconFileText, IconPlus, IconTrash } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { newId, type Template } from '../core/types'

export function TemplatesView({ onApplied }: { onApplied: () => void }) {
  const { state, dispatch, pushUndo } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const [editing, setEditing] = useState<Template | null>(null)

  const startNew = () => {
    const now = Date.now()
    setEditing({
      id: newId('tpl'),
      name: '',
      subject: state.draft.subject,
      body: state.draft.body,
      bodyFormat: state.draft.bodyFormat,
      createdAt: now,
      updatedAt: now,
    })
  }

  const apply = (tpl: Template) => {
    dispatch({
      type: 'setDraft',
      patch: { subject: tpl.subject, body: tpl.body, bodyFormat: tpl.bodyFormat },
    })
    toast.push({ tone: 'success', title: t('templates.apply') })
    onApplied()
  }

  const remove = async (id: string) => {
    const ok = await confirm({
      title: t('confirm.deleteTemplate'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    const template = state.templates.find((tpl) => tpl.id === id)
    if (template) pushUndo(template.name, [{ type: 'upsertTemplate', template }])
    dispatch({ type: 'removeTemplate', id })
  }

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('templates.title')}
          hideTitle
          action={
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={startNew}>
              {t('templates.add')}
            </Button>
          }
        />

        {state.templates.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconFileText size={24} />}
              title={t('templates.empty')}
            />
          </div>
        ) : (
          <VirtualList
            items={state.templates}
            keyOf={(tpl) => tpl.id}
            estimate={68}
            scrollerClassName="list-pane"
            surfaceClassName="card card--flush"
          >
            {(tpl) => (
              <div className="log" style={{ alignItems: 'center' }}>
                <div className="log__body">
                  <div className="log__title">{tpl.name || tpl.subject}</div>
                  <div className="log__detail">
                    {tpl.subject} · {formatDateTime(tpl.updatedAt)}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => apply(tpl)}>
                  {t('templates.apply')}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(tpl)}>
                  {t('common.edit')}
                </Button>
                <IconButton label={t('common.delete')} onClick={() => remove(tpl.id)}>
                  <IconTrash size={16} />
                </IconButton>
              </div>
            )}
          </VirtualList>
        )}
      </div>

      <Modal
        open={editing !== null}
        wide
        title={t('templates.add')}
        onClose={() => setEditing(null)}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!editing?.name.trim()}
              onClick={() => {
                if (editing) {
                  dispatch({
                    type: 'upsertTemplate',
                    template: { ...editing, updatedAt: Date.now() },
                  })
                }
                setEditing(null)
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <>
            <Field label={t('templates.name')}>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label={t('compose.subject')}>
              <input
                className="input"
                value={editing.subject}
                onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
              />
            </Field>
            <Field label={t('compose.body')}>
              <textarea
                className="textarea"
                value={editing.body}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              />
            </Field>
          </>
        ) : null}
      </Modal>

      {confirmElement}
    </div>
  )
}
