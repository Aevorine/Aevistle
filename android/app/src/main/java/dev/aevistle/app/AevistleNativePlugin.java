package dev.aevistle.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Android half of `PlatformBridge`.
 *
 * Method names and payload shapes match `src/core/bridge-android.ts` exactly;
 * that file is the contract. Anything touching the network runs on a worker
 * thread — Android throws NetworkOnMainThreadException, and rightly so.
 */
@CapacitorPlugin(
        name = "AevistleNative",
        permissions = {
                /*
                 * POST_NOTIFICATIONS was in the manifest and was never once
                 * requested, which on Android 13+ means it was never held —
                 * see Permissions.java. Declaring it here is what gives this
                 * plugin Capacitor's request plumbing: the alias below is the
                 * handle for `requestPermissionForAlias`, and Capacitor's own
                 * cache of a permanent refusal (the only place Android exposes
                 * that distinction) is keyed off it too.
                 *
                 * SCHEDULE_EXACT_ALARM is deliberately NOT listed. It is a
                 * special app access, not a runtime permission: there is no
                 * dialog to request, and pretending otherwise here would make
                 * `checkPermissions` report a state no request could ever
                 * change. It is handled through the settings intent instead.
                 */
                @Permission(
                        strings = {Permissions.POST_NOTIFICATIONS},
                        alias = Permissions.ALIAS_NOTIFICATIONS)
        })
public class AevistleNativePlugin extends Plugin {

    /**
     * A pool, not a single thread.
     *
     * With one worker, a connection attempt that sits on an unresponsive
     * server blocks every later call behind it — so pressing "Test connection"
     * while a send was stuck left the button on "Testing…" without a single
     * packet having been sent for it. Four threads is more than this app will
     * ever need concurrently and removes the queue entirely.
     */
    private final ExecutorService io = Executors.newFixedThreadPool(4);

    // -----------------------------------------------------------------------
    // Secrets
    // -----------------------------------------------------------------------

    @PluginMethod
    public void setSecret(PluginCall call) {
        String accountId = call.getString("accountId");
        String secret = call.getString("secret");
        String kind = call.getString("kind", "smtp");
        if (accountId == null || secret == null) {
            call.reject("accountId and secret are required");
            return;
        }
        try {
            new SecretStore(getContext()).put(accountId, kind, secret);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not store the password securely: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasSecret(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String kind = call.getString("kind", "smtp");
        JSObject result = new JSObject();
        result.put("value", new SecretStore(getContext()).has(accountId, kind));
        call.resolve(result);
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String kind = call.getString("kind", "smtp");
        new SecretStore(getContext()).remove(accountId, kind);
        // Deleting the IMAP credential is also the signal that this account's
        // background sync should stop — see InboxCache.remove().
        if ("imap".equals(kind)) {
            new InboxCache(getContext()).remove(accountId);
            InboxSyncScheduler.rearm(getContext());
        }
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Mail
    // -----------------------------------------------------------------------

    @PluginMethod
    public void sendNow(final PluginCall call) {
        final JSObject draft = call.getObject("draft");
        final JSObject account = call.getObject("account");
        if (draft == null || account == null) {
            call.reject("draft and account are required");
            return;
        }

        io.execute(() -> {
            String secret = new SecretStore(getContext()).get(account.optString("id", ""), "smtp");
            MailSender.Result result = MailSender.send(draft, account, secret);
            resolveResult(call, result);
        });
    }

    @PluginMethod
    public void testConnection(final PluginCall call) {
        final JSObject account = call.getObject("account");
        if (account == null) {
            call.reject("account is required");
            return;
        }
        final String provided = call.getString("secret");

        io.execute(() -> {
            String secret = provided != null
                    ? provided
                    : new SecretStore(getContext()).get(account.optString("id", ""), "smtp");
            MailSender.Result result = MailSender.test(account, secret);
            resolveResult(call, result);
        });
    }

    /**
     * Hand a {@link MailSender.Result} back to JavaScript.
     *
     * {@code JSObject.fromJSONObject} is declared to throw, and a send that
     * succeeded must not be reported as a failure just because re-serialising
     * the result tripped — so the fallback builds the response by hand.
     */
    private void resolveResult(PluginCall call, MailSender.Result result) {
        try {
            call.resolve(JSObject.fromJSONObject(result.toJson()));
        } catch (Exception e) {
            JSObject fallback = new JSObject();
            fallback.put("ok", result.ok);
            fallback.put("accepted", new JSArray());
            fallback.put("rejected", new JSArray());
            fallback.put("durationMs", result.durationMs);
            fallback.put("error", result.error != null ? result.error : e.getMessage());
            fallback.put("errorKind", result.errorKind != null ? result.errorKind : "unknown");
            call.resolve(fallback);
        }
    }

    // -----------------------------------------------------------------------
    // Inbox (receiving)
    //
    // Mirrors electron/imap.ts's IPC handlers — same method names and payload
    // shapes as `src/core/bridge.ts`'s optional inbox methods, so
    // `bridge-android.ts` is a thin pass-through, same as the SMTP methods
    // above. Every method here also doubles as how the native side learns
    // which accounts the periodic background sync (InboxSyncWorker) should
    // touch: there is no separate "push config" call, because `syncInbox` is
    // already called with the full account config on every enable, disable,
    // and manual refresh (see AppState.tsx's saveInboxAccount).
    // -----------------------------------------------------------------------

    /**
     * The receive password, falling back to the send password for the same
     * account.
     *
     * Matches the desktop's `getInboxSecret`: every provider this app presets
     * issues one app password that authenticates both SMTP and IMAP, so
     * demanding it a second time only creates a way to typo it.
     */
    private String inboxSecret(String accountId) {
        SecretStore store = new SecretStore(getContext());
        String imap = store.get(accountId, "imap");
        return imap != null ? imap : store.get(accountId, "smtp");
    }

    @PluginMethod
    public void testInbox(final PluginCall call) {
        final JSObject config = call.getObject("config");
        if (config == null) {
            call.reject("config is required");
            return;
        }
        final String provided = call.getString("secret");

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String secret = provided != null
                        ? provided
                        : inboxSecret(configJson.optString("accountId", ""));
                resolveResult(call, MailFetcher.test(configJson, secret));
            } catch (Exception e) {
                call.reject("Could not test the inbox connection: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void syncInbox(final PluginCall call) {
        final JSObject config = call.getObject("config");
        if (config == null) {
            call.reject("config is required");
            return;
        }

        io.execute(() -> {
            InboxCache cache = new InboxCache(getContext());
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String accountId = configJson.optString("accountId", "");
                boolean enabled = configJson.optBoolean("enabled", false);
                String secret = enabled ? inboxSecret(accountId) : null;

                // The other moment notifications become worth asking about:
                // receiving was just switched on, and the thing this app
                // notifies about most urgently — a verification code arriving —
                // only exists once an inbox does. Only on the transition, so a
                // routine refresh of an already-enabled account asks nothing.
                JSONObject known = cache.account(accountId);
                if (enabled && (known == null || !known.optBoolean("enabled", false))) {
                    Permissions.notePromptDue(getContext());
                }

                JSONObject updated = MailFetcher.sync(getContext(), configJson, secret);
                cache.upsert(updated);
                InboxSyncScheduler.rearm(getContext());
                call.resolve(JSObject.fromJSONObject(updated));
            } catch (Exception e) {
                call.reject("Could not sync the inbox: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getMessageBody(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        if (config == null || uidArg == null) {
            call.reject("config and uid are required");
            return;
        }

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String accountId = configJson.optString("accountId", "");
                String secret = inboxSecret(accountId);
                JSONObject body = MailFetcher.fetchBody(getContext(), configJson, secret, folderPath, uidArg);
                call.resolve(JSObject.fromJSONObject(body));
            } catch (Exception e) {
                call.reject("Could not fetch the message: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void setMessageFlags(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        final JSObject patch = call.getObject("patch");
        if (config == null || uidArg == null) {
            call.reject("config and uid are required");
            return;
        }

        // `seen` is best-effort against the server; local state already
        // updated on the JS side regardless (see PlatformBridge.setMessageFlags'
        // doc comment) — so this always resolves rather than rejecting on a
        // network failure the user has no action to take on.
        io.execute(() -> {
            if (patch != null && patch.has("seen")) {
                try {
                    JSONObject configJson = new JSONObject(config.toString());
                    String secret = inboxSecret(configJson.optString("accountId", ""));
                    MailFetcher.setSeen(configJson, secret, folderPath, uidArg, patch.optBoolean("seen", true));
                } catch (Exception ignored) {
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteInboxMessages(PluginCall call) {
        String accountId = call.getString("accountId", "");
        JSArray items = call.getArray("items");
        new InboxCache(getContext()).deleteMessages(accountId, items == null ? new JSONArray() : items);
        call.resolve();
    }

    /**
     * The other kind of delete: on the server, not just in the cache.
     *
     * Rejects when the server refuses. The web layer only drops the rows after
     * this resolves, so a failure leaves the mailbox and the app agreeing with
     * each other instead of the app claiming a deletion that never happened.
     */
    @PluginMethod
    public void purgeInboxMessages(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final JSArray items = call.getArray("items");
        if (config == null) {
            call.reject("config is required");
            return;
        }
        io.execute(() -> {
            try {
                String accountId = config.optString("accountId", "");
                String secret = new SecretStore(getContext()).get(accountId, "imap");
                JSONArray list = items == null ? new JSONArray() : items;
                MailFetcher.purge(config, secret, list);
                // Cache last: a cache entry for a message still on the server is
                // recoverable, a missing one for a message we failed to delete
                // is a hole the user cannot see.
                new InboxCache(getContext()).deleteMessages(accountId, list);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void fetchRemoteImage(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        io.execute(() -> {
            try {
                String dataUri = RemoteImageFetcher.fetch(url);
                JSObject result = new JSObject();
                result.put("value", dataUri);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not load the image: " + e.getMessage(), e);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, Intent.createChooser(intent, "Add attachments"), "filesPicked");
    }

    @ActivityCallback
    private void filesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject response = new JSObject();
        JSArray files = new JSArray();

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            response.put("files", files);
            call.resolve(response);
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        // Copy immediately into the app's own storage. A content:// URI is only
        // valid while the grant lasts, and a reminder scheduled for next week
        // would find it revoked. A real file always works.
        File dir = new File(DataRoot.attachments(getContext()), "inbox");
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("Could not create the attachment directory");
            return;
        }

        int index = 0;
        for (Uri uri : uris) {
            try {
                String name = displayName(uri, "attachment-" + index);
                File target = new File(dir, System.currentTimeMillis() + "_" + index + "_" + safeName(name));
                long size = copy(uri, target);

                JSObject file = new JSObject();
                file.put("id", "att_" + System.currentTimeMillis() + "_" + index);
                file.put("name", name);
                file.put("size", size);
                file.put("mime", mimeOf(uri));
                file.put("source", "copy");
                file.put("path", target.getAbsolutePath());
                file.put("addedAt", System.currentTimeMillis());
                file.put("inline", false);
                files.put(file);
                index++;
            } catch (Exception e) {
                // One unreadable file must not lose the others.
                index++;
            }
        }

        response.put("files", files);
        call.resolve(response);
    }

    // -----------------------------------------------------------------------
    // Received attachments
    //
    // Three separate capabilities, because they answer three different
    // questions and only the first of them needs the network:
    //
    //   downloadInboxAttachment — the bytes are still on the server; fetch them
    //   readAttachment          — show it inside the app, without leaving it
    //   saveAttachmentAs / To   — hand a copy to the user's own storage
    //
    // Desktop has had all three since the inbox landed; Android listed
    // attachments and could do nothing with any of them, which made a received
    // attachment on a phone a row of text.
    // -----------------------------------------------------------------------

    @PluginMethod
    public void downloadInboxAttachment(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        final Integer partIndex = call.getInt("partIndex");
        final String name = call.getString("name", "attachment");
        if (config == null || uidArg == null || partIndex == null) {
            call.reject("config, uid and partIndex are required");
            return;
        }

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String secret = inboxSecret(configJson.optString("accountId", ""));
                JSONObject file = MailFetcher.downloadAttachment(
                        getContext(), configJson, secret, folderPath, uidArg, partIndex, name);
                call.resolve(JSObject.fromJSONObject(file));
            } catch (Exception e) {
                call.reject("Could not download the attachment: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Read a downloaded attachment back as a {@code data:} URL for previewing.
     *
     * The same three limits the desktop handler applies, for the same reasons:
     * confined to the app's own data folder, capped in size (the result crosses
     * the JS bridge as base64 and grows by a third doing it), and restricted to
     * types that render inertly. SVG is excluded despite being an image — it is
     * a document format that can carry script.
     *
     * Resolves {@code {value: null}} rather than rejecting when it will not
     * preview: the caller's fallback is to hand the file to another app, which
     * is a normal outcome and not an error worth showing.
     */
    @PluginMethod
    public void readAttachment(final PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }

        io.execute(() -> {
            JSObject result = new JSObject();
            try {
                File file = new File(path).getCanonicalFile();
                if (!insideDataRoot(file) || !file.isFile() || file.length() > PREVIEW_MAX_BYTES) {
                    call.resolve(result);
                    return;
                }
                String mime = mimeOfName(file.getName());
                if (!PREVIEWABLE.contains(mime)) {
                    call.resolve(result);
                    return;
                }
                byte[] bytes = readAll(file);
                result.put("dataUrl", "data:" + mime + ";base64,"
                        + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                result.put("mime", mime);
                call.resolve(result);
            } catch (Exception e) {
                // Unreadable is "cannot preview", not "something broke".
                call.resolve(result);
            }
        });
    }

    /**
     * Hand the file to whichever app the user has for that type.
     *
     * Through {@code FileProvider}: a {@code file://} URI has thrown
     * FileUriExposedException since Android 7, and the receiving app needs a
     * grant rather than a path it has no permission to open.
     */
    @PluginMethod
    public void openPath(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        try {
            File file = new File(path).getCanonicalFile();
            if (!insideDataRoot(file) || !file.isFile()) {
                call.reject("That file is not available");
                return;
            }
            Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mimeOfName(file.getName()))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(view, file.getName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this device can open that file", e);
        }
    }

    /**
     * "Save a copy where I choose."
     *
     * Android has no writable path outside the app's own storage, so the
     * destination is a {@code content://} URI from the system's create-document
     * dialog. The source stays confined to the data folder exactly as it is for
     * reading; the destination is wherever the user just pointed at, which is
     * the entire point.
     */
    @PluginMethod
    public void saveAttachmentAs(PluginCall call) {
        String path = call.getString("path");
        String suggested = call.getString("suggestedName", "attachment");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeOfName(suggested))
                .putExtra(Intent.EXTRA_TITLE, new File(suggested).getName());
        startActivityForResult(call, intent, "attachmentSaveTargetPicked");
    }

    @ActivityCallback
    private void attachmentSaveTargetPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            call.resolve(response); // cancelled — `value` absent
            return;
        }
        try {
            File source = new File(call.getString("path", "")).getCanonicalFile();
            if (!insideDataRoot(source) || !source.isFile()) {
                call.reject("That file is not available");
                return;
            }
            copyToUri(source, target);
            response.put("value", displayName(target, source.getName()));
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage(), e);
        }
    }

    /** The same, for every attachment on a message: one folder, one dialog. */
    @PluginMethod
    public void saveAttachmentsTo(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null || paths.length() == 0) {
            call.reject("paths is required");
            return;
        }
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE),
                "attachmentSaveFolderPicked");
    }

    @ActivityCallback
    private void attachmentSaveFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        Uri tree = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            call.resolve(response); // cancelled — `saved` absent
            return;
        }

        try {
            androidx.documentfile.provider.DocumentFile folder =
                    androidx.documentfile.provider.DocumentFile.fromTreeUri(getContext(), tree);
            if (folder == null || !folder.canWrite()) {
                call.reject("That folder cannot be written to");
                return;
            }

            JSArray paths = call.getArray("paths");
            int saved = 0;
            for (int i = 0; i < paths.length(); i++) {
                try {
                    File source = new File(paths.getString(i)).getCanonicalFile();
                    if (!insideDataRoot(source) || !source.isFile()) continue;
                    // Never overwrite: two mails routinely attach `invoice.pdf`,
                    // and a silent overwrite would destroy the first one with no
                    // way to tell. `createFile` on SAF already de-duplicates by
                    // appending a counter, which is the behaviour we want.
                    androidx.documentfile.provider.DocumentFile target =
                            folder.createFile(mimeOfName(source.getName()), source.getName());
                    if (target == null) continue;
                    copyToUri(source, target.getUri());
                    saved++;
                } catch (Exception ignored) {
                    // One unwritable file must not abandon the rest of the batch.
                }
            }

            response.put("folder", displayName(tree, tree.getLastPathSegment()));
            response.put("saved", saved);
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not save the attachments: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void snapshotAttachments(PluginCall call) {
        JSArray attachments = call.getArray("attachments");
        String jobId = call.getString("jobId", "job");
        JSObject response = new JSObject();
        JSArray out = new JSArray();

        if (attachments == null) {
            response.put("files", out);
            call.resolve(response);
            return;
        }

        File dir = new File(DataRoot.attachments(getContext()), safeName(jobId));
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("Could not create the snapshot directory");
            return;
        }

        try {
            for (int i = 0; i < attachments.length(); i++) {
                JSONObject a = attachments.getJSONObject(i);
                File source = new File(a.optString("path", ""));
                if (!source.isFile()) continue;

                File target = new File(dir, a.optString("id", String.valueOf(i))
                        + "_" + safeName(a.optString("name", "attachment")));
                copyFile(source, target);

                JSONObject copy = new JSONObject(a.toString());
                copy.put("source", "copy");
                copy.put("path", target.getAbsolutePath());
                out.put(copy);
            }
        } catch (Exception e) {
            call.reject("Could not copy the attachments: " + e.getMessage(), e);
            return;
        }

        response.put("files", out);
        call.resolve(response);
    }

    // -----------------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------------

    @PluginMethod
    public void syncJobs(PluginCall call) {
        JSArray jobs = call.getArray("jobs");
        JSArray accounts = call.getArray("accounts");

        JobStore store = new JobStore(getContext());
        // Which reminders were armed a moment ago, and which are armed now.
        // The difference is the only thing separating "the user just armed
        // their first reminder" — a moment where asking for notification
        // permission explains itself — from "the app just started and re-sent
        // the same list", which is the moment people deny by reflex.
        // `ensureNotificationPermission` acts on the flag this sets; see there.
        Set<String> before = jobIds(store.jobs());
        JSONArray incoming = jobs == null ? new JSONArray() : jobs;
        Permissions.noteNewlyArmed(getContext(), before, jobIds(incoming));

        store.save(incoming, accounts == null ? new JSONArray() : accounts);

        AevistleScheduler.rearmAll(getContext());
        call.resolve();
    }

    private static Set<String> jobIds(JSONArray jobs) {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            // Only jobs that will actually fire count. The web layer already
            // filters to enabled before it calls, but a disabled one arriving
            // here must not be read as a reason to ask for permission.
            if (!job.optBoolean("enabled", false)) continue;
            String id = job.optString("id", "");
            if (!id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    /**
     * Hand over every send that happened while the web layer was not running.
     *
     * The desktop learns about a run from a live event because its scheduler
     * and its window are in the same process. Android's is not: the alarm fires
     * into a worker with no WebView attached, so there is nobody to notify at
     * the moment it matters. {@link JobStore#recordRun} queues the report
     * instead and this drains it — which is why a schedule that fired overnight
     * now reads "sent" when the app is opened rather than still claiming to be
     * waiting.
     *
     * Absolute state, not deltas, so redelivering a report is harmless.
     */
    @PluginMethod
    public void pullJobRuns(PluginCall call) {
        JSObject result = new JSObject();
        result.put("runs", new JobStore(getContext()).drainRuns());
        call.resolve(result);
    }

    // -----------------------------------------------------------------------
    // Misc
    // -----------------------------------------------------------------------

    /**
     * Raise a system notification on behalf of the JavaScript side.
     *
     * This used to be an empty {@code call.resolve()} carrying a comment that
     * claimed the scheduled-send worker delivered it. Nothing did — it reported
     * success and produced nothing, so every notification the app asked for on
     * Android (a send confirmation, and later the arrival of a verification
     * code) silently went nowhere.
     *
     * A code goes to its own high-importance channel so it arrives as a
     * heads-up: the whole value of that notification is being readable without
     * switching apps. Everything else is a status message.
     */
    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "Aevistle");
        String body = call.getString("body", "");
        boolean isCode = Boolean.TRUE.equals(call.getBoolean("code", false));
        try {
            if (isCode) Notifier.code(getContext(), title, title, body);
            else Notifier.status(getContext(), title + body, title, body);
        } catch (Exception ignored) {
            // A refused or unavailable notification must not fail the caller:
            // the code is already on the codes screen either way.
        }
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Permissions
    //
    // Two of them, behaving nothing alike, and the UI has to be able to say
    // which is which — see Permissions.java for what each one costs when it is
    // missing. Everything below is a report or a response to a tap; nothing
    // here raises a dialog or opens a settings screen on its own.
    // -----------------------------------------------------------------------

    /**
     * What the app is actually allowed to do right now.
     *
     * The health strip used to infer this. It could see that arming had failed
     * and guessed at exact alarms as the likely reason, and it had no way at
     * all to know notifications were off — so the one failure that silences
     * every send report on a modern phone was invisible to the screen whose
     * job is to list what is wrong.
     */
    @PluginMethod
    public void permissionState(PluginCall call) {
        call.resolve(permissionSnapshot());
    }

    private String notificationState() {
        PermissionState state = getPermissionState(Permissions.ALIAS_NOTIFICATIONS);
        return Permissions.notifications(getContext(), state == null ? null : state.toString());
    }

    /**
     * Would {@code requestNotificationPermission} actually produce a dialog?
     *
     * False for granted, for blocked, and for every Android below 13. Blocked
     * is the one that matters: a button offering to ask again would do nothing
     * at all there, and {@code openNotificationSettings} is the only honest
     * offer left.
     */
    private boolean canAskNotifications() {
        return android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
                && Permissions.PROMPT.equals(notificationState());
    }

    private JSObject permissionSnapshot() {
        JSObject result = new JSObject();
        result.put("notifications", notificationState());
        result.put("exactAlarms", Permissions.exactAlarms(getContext()));
        result.put("canAskNotifications", canAskNotifications());
        return result;
    }

    /**
     * Ask for notifications, now, because the user asked us to.
     *
     * The explicit route: a button in the app. Resolves with the state
     * afterwards either way, so a refusal updates the screen rather than
     * leaving it claiming the request is still in flight.
     */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (!canAskNotifications()) {
            // Granted, blocked, or a platform with no such permission. In all
            // three cases the dialog will not appear, and launching the request
            // anyway would resolve instantly with an unchanged state that looks
            // like the user declined.
            JSObject result = permissionSnapshot();
            result.put("prompted", false);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(Permissions.ALIAS_NOTIFICATIONS, call, "notificationPermissionResult");
    }

    /**
     * Ask only if this is a moment that earns it.
     *
     * The bridge calls this straight after arming a schedule or enabling an
     * inbox, and the native side decides whether anything actually changed —
     * {@link Permissions#takePromptDue}. Cold start re-sends the jobs that were
     * already armed, so without that check every launch would open with a
     * permission dialog and no visible reason for it, which is the pattern
     * people deny by reflex.
     */
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        boolean askable = canAskNotifications();
        // Consumed only when it could have been used: a moment that earned a
        // prompt on an Android that cannot show one must not burn the flag,
        // or upgrading the phone would lose the prompt it was saving up.
        boolean due = askable && Permissions.takePromptDue(getContext());
        if (!due) {
            JSObject result = permissionSnapshot();
            result.put("prompted", false);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(Permissions.ALIAS_NOTIFICATIONS, call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject result = permissionSnapshot();
        result.put("prompted", true);
        call.resolve(result);
    }

    /**
     * The route out of a permanent refusal.
     *
     * Once Android has recorded "don't ask again" there is no dialog left; the
     * app's only remaining honest move is to say so and offer to open the
     * screen where it can be undone.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("opened", Permissions.openNotificationSettings(getContext(), getActivity()));
        call.resolve(result);
    }

    /**
     * The equivalent for exact alarms — which is the *only* route, since this
     * one never had a dialog.
     *
     * Fired from a tap, never from launch. `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`
     * on app start is exactly the behaviour Google's own guidance calls out,
     * and it is also useless: a user who has not yet been told why they are
     * looking at a settings screen backs out of it.
     */
    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("opened", Permissions.openExactAlarmSettings(getContext(), getActivity()));
        call.resolve(result);
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject info = new JSObject();
        info.put("version", BuildConfig.VERSION_NAME);
        info.put("platform", "android");
        info.put("os", "Android " + android.os.Build.VERSION.RELEASE + " · " + android.os.Build.MODEL);
        info.put("dataLocation", DataRoot.dir(getContext()).getAbsolutePath());
        call.resolve(info);
    }

    // -----------------------------------------------------------------------
    // Data folder
    // -----------------------------------------------------------------------

    @PluginMethod
    public void dataFolder(PluginCall call) {
        JSObject info = new JSObject();
        info.put("path", DataRoot.dir(getContext()).getAbsolutePath());
        info.put("isDefault", DataRoot.ID_DEFAULT.equals(DataRoot.currentId(getContext())));
        info.put("sizeBytes", DataRoot.size(getContext()));
        // Android grants storage per volume, not per directory — see DataRoot.
        info.put("canPickAny", false);
        info.put("options", DataRoot.options(getContext()));

        JSArray stays = new JSArray();
        stays.put("secrets");
        stays.put("schedule");
        info.put("staysBehind", stays);

        call.resolve(info);
    }

    @PluginMethod
    public void useDataFolder(final PluginCall call) {
        final String optionId = call.getString("optionId", DataRoot.ID_DEFAULT);
        final boolean move = Boolean.TRUE.equals(call.getBoolean("move", true));
        final String before = DataRoot.dir(getContext()).getAbsolutePath();

        // Copying attachments can take a moment on a slow card; the UI thread
        // is not the place for it.
        io.execute(() -> {
            try {
                String warning = DataRoot.switchTo(getContext(), optionId, move);
                String after = DataRoot.dir(getContext()).getAbsolutePath();

                JSObject result = new JSObject();
                result.put("changed", !before.equals(after));
                result.put("path", after);
                result.put("moved", move && !before.equals(after));
                if (warning != null) result.put("warning", warning);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not switch storage location" : e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void openDataFolder(PluginCall call) {
        // No reliable "reveal this path" intent exists across OEM file
        // managers; the settings panel shows the full path instead, which is
        // what a user needs to find it over USB anyway.
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private String displayName(Uri uri, String fallback) {
        try (Cursor cursor = getContext().getContentResolver()
                .query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private String mimeOf(Uri uri) {
        String type = getContext().getContentResolver().getType(uri);
        return type == null ? "application/octet-stream" : type;
    }

    /** 24 MB of file becomes ~32 MB of base64 in transit; past that, offer another app instead. */
    private static final long PREVIEW_MAX_BYTES = 24L * 1024 * 1024;

    /**
     * What {@code readAttachment} is willing to hand back.
     *
     * SVG is excluded even though it is an image: it is a document that can
     * carry script, and the preview surface's job is to be boring.
     */
    private static final java.util.Set<String> PREVIEWABLE = new java.util.HashSet<>(
            java.util.Arrays.asList(
                    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
                    "image/avif", "application/pdf", "text/plain", "text/csv"));

    private static String mimeOfName(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        switch (ext) {
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "bmp": return "image/bmp";
            case "avif": return "image/avif";
            case "pdf": return "application/pdf";
            case "txt": case "log": case "md": return "text/plain";
            case "csv": return "text/csv";
            case "zip": return "application/zip";
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            default: return "application/octet-stream";
        }
    }

    /**
     * Is this file inside the folder this app owns?
     *
     * The same confinement the desktop's path handlers apply, and for the same
     * reason: every one of these methods takes a bare string from the WebView,
     * and without this a crafted path could read or copy out any file the
     * process can see. Canonicalised on both sides so {@code ../} cannot walk
     * out, and both roots are checked because the data folder can be moved to
     * external storage while older attachments remain internal.
     */
    private boolean insideDataRoot(File file) {
        try {
            String target = file.getCanonicalPath();
            for (File root : new File[]{DataRoot.dir(getContext()), getContext().getFilesDir()}) {
                if (root == null) continue;
                String prefix = root.getCanonicalPath() + File.separator;
                if (target.startsWith(prefix)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private static byte[] readAll(File file) throws Exception {
        try (InputStream in = new java.io.FileInputStream(file);
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }

    private void copyToUri(File source, Uri target) throws Exception {
        try (InputStream in = new java.io.FileInputStream(source);
             OutputStream out = getContext().getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IllegalStateException("Cannot write to " + target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }

    /** Strip anything that could escape the directory we intend to write into. */
    private static String safeName(String name) {
        String base = new File(name).getName();
        return base.replaceAll("[^A-Za-z0-9._\\-]", "_");
    }

    private long copy(Uri uri, File target) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IllegalStateException("Cannot read " + uri);
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                total += read;
            }
            return total;
        }
    }

    private static void copyFile(File source, File target) throws Exception {
        try (InputStream in = new java.io.FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }
}
