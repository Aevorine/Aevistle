import { useDeferredValue, useMemo, useState } from 'react'
import { VirtualList } from '../components/VirtualList'
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHead,
  useConfirm,
} from '../components/ui'
import { IconFlag, IconPlus, IconTrash, IconUsers } from '../components/icons'
import { DeliveryWindowEditor } from '../components/DeliveryWindowEditor'
import { useApp } from '../state/AppState'
import { SearchInput } from '../components/inputs'
import { useI18n } from '../i18n'
import { isValidAddress } from '../core/validate'
import { newId, type Contact } from '../core/types'

export function ContactsView() {
  const { state, dispatch, pushUndo } = useApp()
  const { t } = useI18n()
  const { confirm, confirmElement } = useConfirm()

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Contact | null>(null)

  /**
   * Pinned first, then grouped by the contact's first tag.
   *
   * Rows carry their own heading rather than the list being a list of groups,
   * because the whole screen is windowed — a nested structure would need the
   * virtualiser to understand two kinds of row, and this needs it to
   * understand one. See `VirtualList`.
   *
   * Grouping is switched off entirely while searching. Someone who has typed
   * three letters wants the matches, not the matches sorted into six headings
   * with one row each.
   */
  // Same reasoning as the inbox: the keystroke lands now, the regrouping
  // catches up. Grouping walks every contact and sorts each bucket, so it is
  // the part worth taking off the typing path.
  const deferredQuery = useDeferredValue(query)
  const rows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const matches = state.contacts.filter(
      (c) =>
        q.length === 0 ||
        c.name.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
    const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name)

    if (q.length > 0) {
      return [...matches].sort(byName).map((contact) => ({ kind: 'contact' as const, contact }))
    }

    const pinned = matches.filter((c) => c.pinned).sort(byName)
    const rest = matches.filter((c) => !c.pinned)

    const groups = new Map<string, Contact[]>()
    for (const c of rest) {
      const key = c.tags[0] ?? ''
      const bucket = groups.get(key)
      if (bucket) bucket.push(c)
      else groups.set(key, [c])
    }

    const out: Array<
      { kind: 'heading'; id: string; label: string } | { kind: 'contact'; contact: Contact }
    > = []
    if (pinned.length > 0) {
      out.push({ kind: 'heading', id: '_pinned', label: t('contacts.pinned') })
      for (const contact of pinned) out.push({ kind: 'contact', contact })
    }
    // Untagged last, for the same reason ungrouped accounts sort last: the
    // named groups are the part the user actually organised.
    const names = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))
    if (groups.has('')) names.push('')
    for (const name of names) {
      if (groups.size > 1 || pinned.length > 0) {
        out.push({ kind: 'heading', id: `g_${name}`, label: name || t('contacts.untagged') })
      }
      for (const contact of groups.get(name)!.sort(byName)) out.push({ kind: 'contact', contact })
    }
    return out
  }, [state.contacts, deferredQuery, t])

  const remove = async (id: string) => {
    const ok = await confirm({
      title: t('confirm.deleteContact'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    const contact = state.contacts.find((c) => c.id === id)
    // Recorded before the removal — after it there is nothing left to record.
    if (contact) pushUndo(contact.name || contact.address, [{ type: 'upsertContact', contact }])
    dispatch({ type: 'removeContact', id })
  }

  const startNew = () =>
    setEditing({ id: newId('c'), name: '', address: '', tags: [], createdAt: Date.now() })

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('contacts.title')}
          subtitle={t('contacts.subtitle')}
          action={
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={startNew}>
              {t('contacts.add')}
            </Button>
          }
        />

        {state.contacts.length > 0 ? (
          <SearchInput value={query} onChange={setQuery} placeholder={t('common.search')} />
        ) : null}

        {/* Heading, "Add contact" and the search box stay put above this. */}
        {rows.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconUsers size={24} />}
              title={state.contacts.length === 0 ? t('contacts.empty') : t('common.empty')}
              hint={state.contacts.length === 0 ? t('contacts.emptyHint') : t('common.noMatchHint')}
            />
          </div>
        ) : (
          <VirtualList
            items={rows}
            keyOf={(row) => (row.kind === 'heading' ? row.id : row.contact.id)}
            estimate={68}
            scrollerClassName="list-pane"
            surfaceClassName="card card--flush"
          >
            {(row) =>
              row.kind === 'heading' ? (
                <div className="contactgroup">{row.label}</div>
              ) : (
              <div className="log" style={{ alignItems: 'center' }}>
                  <button
                    type="button"
                    className="contact__pin"
                    aria-pressed={row.contact.pinned === true}
                    title={row.contact.pinned ? t('contacts.unpin') : t('contacts.pin')}
                    onClick={() =>
                      dispatch({
                        type: 'upsertContact',
                        contact: { ...row.contact, pinned: !row.contact.pinned },
                      })
                    }
                  >
                    <IconFlag size={15} />
                  </button>
                  <div className="log__body">
                    <div className="log__title">{row.contact.name || row.contact.address}</div>
                    <div className="log__detail">
                      {row.contact.address}
                      {row.contact.tags.length > 0 ? ` · ${row.contact.tags.join(', ')}` : ''}
                      {row.contact.note ? ` · ${row.contact.note}` : ''}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => setEditing(row.contact)}>
                    {t('common.edit')}
                  </Button>
                <IconButton label={t('common.delete')} onClick={() => remove(row.contact.id)}>
                  <IconTrash size={16} />
                </IconButton>
              </div>
              )
            }
          </VirtualList>
        )}
      </div>

      <Modal
        open={editing !== null}
        title={t('contacts.add')}
        onClose={() => setEditing(null)}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!editing || !isValidAddress(editing.address)}
              onClick={() => {
                if (editing) dispatch({ type: 'upsertContact', contact: editing })
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
            <Field label={t('contacts.name')}>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label={t('contacts.address')}>
              <input
                className="input"
                type="email"
                spellCheck={false}
                aria-invalid={editing.address.length > 0 && !isValidAddress(editing.address)}
                value={editing.address}
                onChange={(e) => setEditing({ ...editing, address: e.target.value.trim() })}
              />
            </Field>
            <Field label={t('contacts.tags')} optional={t('common.optional')}>
              <input
                className="input"
                value={editing.tags.join(', ')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    tags: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label={t('contacts.note')} optional={t('common.optional')}>
              <input
                className="input"
                value={editing.note ?? ''}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              />
            </Field>

            {/*
              B3 · 送达窗口. The one field on this card that changes *when* mail
              goes out rather than what it says — so it is the one field that
              has to show its own consequence, and it does, live, underneath
              itself. `deliveryWindow` is written straight onto the contact
              being edited and saved by the same button as everything else;
              `undefined` (the switch off) is what every existing contact means
              and must keep meaning.
            */}
            <DeliveryWindowEditor
              value={editing.deliveryWindow}
              name={editing.name}
              address={editing.address}
              jobs={state.jobs}
              onChange={(deliveryWindow) => setEditing({ ...editing, deliveryWindow })}
            />
          </>
        ) : null}
      </Modal>

      {confirmElement}
    </div>
  )
}
