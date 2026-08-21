import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { VirtualList } from '../components/VirtualList'
import { DetailShell } from '../components/DetailShell'
import { useTwoPane } from '../components/useNarrow'
import {
  Banner,
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHead,
  useConfirm,
  useToast,
} from '../components/ui'
import {
  IconFlag,
  IconFolder,
  IconPlus,
  IconSmartphone,
  IconTrash,
  IconUsers,
} from '../components/icons'
import { DeliveryWindowEditor } from '../components/DeliveryWindowEditor'
import { useApp } from '../state/AppState'
import { SearchInput } from '../components/inputs'
import { useI18n } from '../i18n'
import { isValidAddress } from '../core/mail/validate'
import { newId, type Contact } from '../core/types'
import {
  buildContactImport,
  parseContactsCsv,
  type ContactImportResult,
} from '../core/platform/contactImport'

export function ContactsView() {
  const { state, dispatch, pushUndo, bridge } = useApp()
  const { t } = useI18n()
  const { confirm, confirmElement } = useConfirm()
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Contact | null>(null)
  /* The tablet band, decided once in `useNarrow.ts`. The CSV import summary
     below stays a dialog either way: it is a yes/no about a file, not a thing
     you sit and edit beside the list. */
  const twoPane = useTwoPane()

  // --- bulk import ----------------------------------------------------------
  //
  // Desktop: pick a CSV off disk, parse it, show what would happen, then
  // commit on confirm — same three-step shape as `BackupCard`'s restore.
  // Android: `bridge.pickContact` hands back one contact at a time from the
  // system picker (see its doc on `PlatformBridge` for why only one), so
  // there is no preview step there — each pick is small enough that the
  // result toast *is* the summary.
  const csvInput = useRef<HTMLInputElement>(null)
  const [csvError, setCsvError] = useState('')
  const [importPreview, setImportPreview] = useState<ContactImportResult | null>(null)
  const [pickingContact, setPickingContact] = useState(false)

  const skipCounts = useMemo(() => {
    if (!importPreview) return null
    const counts = { invalid: 0, existing: 0, inFile: 0, noAddress: 0 }
    for (const row of importPreview.skipped) {
      if (row.reason === 'invalid-address') counts.invalid++
      else if (row.reason === 'duplicate-existing') counts.existing++
      else if (row.reason === 'duplicate-in-file') counts.inFile++
      else counts.noAddress++
    }
    return counts
  }, [importPreview])

  const pickCsv = async (file: File) => {
    setCsvError('')
    let text: string
    try {
      text = await file.text()
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : String(e))
      return
    }
    const { rows, malformed } = parseContactsCsv(text)
    if (rows.length === 0 && malformed.length === 0) {
      setCsvError(t('contacts.importEmptyFile'))
      return
    }
    setImportPreview(buildContactImport(rows, state.contacts))
  }

  const confirmCsvImport = () => {
    if (!importPreview) return
    const { toAdd } = importPreview
    if (toAdd.length > 0) {
      for (const contact of toAdd) dispatch({ type: 'upsertContact', contact })
      // The whole batch undoes in one step — removing every id just written,
      // not restoring a snapshot, so an unrelated edit made in between (there
      // is a confirm step, so time passes) is never touched by the undo.
      pushUndo(
        t('contacts.importUndoLabel', { n: toAdd.length }),
        toAdd.map((c) => ({ type: 'removeContact' as const, id: c.id })),
      )
    }
    toast.push({
      tone: toAdd.length > 0 ? 'success' : 'info',
      title: t('contacts.importDone', { added: toAdd.length, skipped: importPreview.skipped.length }),
    })
    setImportPreview(null)
  }

  const pickAndroidContact = async () => {
    if (!bridge?.pickContact || pickingContact) return
    setPickingContact(true)
    try {
      const picked = await bridge.pickContact()
      if (picked.cancelled) return
      const address = picked.addresses[0] ?? ''
      const result = buildContactImport(
        [{ line: 1, name: picked.name, address, tags: [], note: undefined }],
        state.contacts,
      )
      const [added] = result.toAdd
      if (added) {
        dispatch({ type: 'upsertContact', contact: added })
        pushUndo(added.name || added.address, [{ type: 'removeContact', id: added.id }])
        toast.push({ tone: 'success', title: t('contacts.importAndroidAdded', { name: added.name || added.address }) })
        return
      }
      const reason = result.skipped[0]?.reason
      const key =
        reason === 'no-address'
          ? 'contacts.importAndroidNoEmail'
          : reason === 'invalid-address'
            ? 'contacts.importAndroidInvalid'
            : 'contacts.importAndroidDuplicate'
      toast.push({ tone: 'info', title: t(key) })
    } catch (e) {
      toast.push({ tone: 'error', title: t('contacts.importAndroidFailed'), detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setPickingContact(false)
    }
  }

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
    <div className={`view view--list view--contacts${twoPane ? ' view--twopane' : ''}`}>
      <div className={`view__inner${twoPane ? ' twopane__list' : ''}`}>
        <PageHead
          title={t('contacts.title')}
          hideTitle
          action={
            <div className="btn-row">
              {/* Android: no file system to browse for a CSV, but the system
                  contacts picker needs no new permission — see `bridge.pickContact`'s
                  doc for why it is one contact per tap rather than a multi-select. */}
              {bridge?.pickContact ? (
                <Button
                  variant="secondary"
                  icon={<IconSmartphone size={15} />}
                  disabled={pickingContact}
                  onClick={() => void pickAndroidContact()}
                >
                  {t('contacts.importAndroid')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  icon={<IconFolder size={15} />}
                  onClick={() => csvInput.current?.click()}
                >
                  {t('contacts.importCsv')}
                </Button>
              )}
              <input
                ref={csvInput}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Cleared so picking the same file twice in a row still fires.
                  e.target.value = ''
                  if (file) void pickCsv(file)
                }}
              />
              <Button variant="primary" icon={<IconPlus size={16} />} onClick={startNew}>
                {t('contacts.add')}
              </Button>
            </div>
          }
        />

        {csvError ? (
          <Banner tone="danger" title={t('contacts.importCannotRead')}>
            {csvError}
          </Banner>
        ) : null}

        {state.contacts.length > 0 ? (
          <SearchInput value={query} onChange={setQuery} placeholder={t('common.search')} />
        ) : null}

        {/* Heading, "Add contact" and the search box stay put above this. */}
        {rows.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconUsers size={24} />}
              title={state.contacts.length === 0 ? t('contacts.empty') : t('common.empty')}
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

      <DetailShell
        twoPane={twoPane}
        open={editing !== null}
        title={t('contacts.add')}
        paneLabel={t('contacts.title')}
        emptyHint={t('twopane.pickContact')}
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
      </DetailShell>

      {/* CSV import summary — shown before anything is written, same reasoning
          as `BackupCard`'s restore preview: "would add N, skip M" is what
          tells someone they picked the wrong file, before it is too late to
          matter. */}
      <Modal
        open={importPreview !== null}
        title={t('contacts.importPreviewTitle')}
        onClose={() => setImportPreview(null)}
        closeLabel={t('common.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportPreview(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!importPreview || importPreview.toAdd.length === 0}
              onClick={confirmCsvImport}
            >
              {t('contacts.importConfirm', { n: importPreview?.toAdd.length ?? 0 })}
            </Button>
          </>
        }
      >
        {importPreview && skipCounts ? (
          <>
            <p className="log__detail">
              {t('contacts.importWillAdd', { n: importPreview.toAdd.length })}
            </p>
            {importPreview.skipped.length > 0 ? (
              <ul className="prose">
                {skipCounts.existing > 0 ? (
                  <li>{t('contacts.importSkipExisting', { n: skipCounts.existing })}</li>
                ) : null}
                {skipCounts.inFile > 0 ? (
                  <li>{t('contacts.importSkipInFile', { n: skipCounts.inFile })}</li>
                ) : null}
                {skipCounts.invalid > 0 ? (
                  <li>{t('contacts.importSkipInvalid', { n: skipCounts.invalid })}</li>
                ) : null}
                {skipCounts.noAddress > 0 ? (
                  <li>{t('contacts.importSkipNoAddress', { n: skipCounts.noAddress })}</li>
                ) : null}
              </ul>
            ) : null}
            {importPreview.toAdd.length === 0 ? (
              <Banner tone="warning" title={t('contacts.importNothingToAdd')} />
            ) : null}
          </>
        ) : null}
      </Modal>

      {confirmElement}
    </div>
  )
}
