package dev.aevistle.app;

import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import javax.mail.Address;
import javax.mail.BodyPart;
import javax.mail.Flags;
import javax.mail.Folder;
import javax.mail.Message;
import javax.mail.Multipart;
import javax.mail.Part;
import javax.mail.Session;
import javax.mail.Store;
import javax.mail.UIDFolder;
import javax.mail.internet.InternetAddress;
import javax.mail.internet.MimeUtility;

/**
 * IMAP on Android, via JavaMail.
 *
 * Mirrors `electron/imap.ts` in scope, not line for line — the desktop file's
 * header explains the boundaries and they apply here unchanged: INBOX only,
 * no folder hierarchy, polling rather than IDLE (a periodic WorkManager job
 * plays the role the desktop's timer does), and a bounded body prefetch so an
 * account with years of mail does not try to download all of it on the first
 * sync. Reuses {@link MailSender}'s endpoint ladder and error classification
 * rather than re-deriving them — a misconfigured port or a slow DNS server is
 * the same failure on either protocol.
 */
final class MailFetcher {

    private static final int LIST_LIMIT = 50;
    private static final int BODY_PREFETCH_LIMIT = 15;
    private static final long PREFETCH_MAX_BYTES = 2L * 1024 * 1024;
    private static final long ATTACHMENT_MAX_BYTES = 10L * 1024 * 1024;

    private MailFetcher() {
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    private static Session buildSession(JSONObject config, MailSender.Endpoint endpoint) {
        int timeout = 15000;
        Properties props = new Properties();
        props.put("mail.imap.host", config.optString("imapHost", ""));
        props.put("mail.imap.port", String.valueOf(endpoint.port));
        props.put("mail.imap.connectiontimeout", String.valueOf(timeout));
        props.put("mail.imap.timeout", String.valueOf(timeout));
        props.put("mail.imap.writetimeout", String.valueOf(timeout));
        props.put("mail.imap.ssl.protocols", "TLSv1.2 TLSv1.3");
        props.put("mail.imap.connectionpoolsize", "1");

        if ("ssl".equals(endpoint.security)) {
            props.put("mail.imap.ssl.enable", "true");
        } else if ("starttls".equals(endpoint.security)) {
            props.put("mail.imap.starttls.enable", "true");
            props.put("mail.imap.starttls.required", "true");
        }

        if (config.optBoolean("imapAllowInvalidCert", false)) {
            props.put("mail.imap.ssl.trust", "*");
            props.put("mail.imap.ssl.checkserveridentity", "false");
        } else {
            props.put("mail.imap.ssl.checkserveridentity", "true");
        }

        return Session.getInstance(props);
    }

    private static List<MailSender.Endpoint> ladderFor(JSONObject config) {
        return MailSender.ladder(
                config.optInt("imapPort", 993),
                config.optString("imapSecurity", "ssl"),
                true);
    }

    private interface WithStore<T> {
        T run(Store store, Folder inbox) throws Exception;
    }

    /** Walk the same port/security ladder `MailSender` uses, open INBOX, run, close. */
    private static <T> T withInbox(JSONObject config, String secret, int folderMode, WithStore<T> body)
            throws Exception {
        String host = config.optString("imapHost", "");
        String username = config.optString("imapUsername", "");
        if (TextUtils.isEmpty(host)) throw new IllegalArgumentException("Invalid IMAP host");
        if (TextUtils.isEmpty(secret)) throw new IllegalArgumentException("No IMAP password stored for this account");

        List<MailSender.Endpoint> rungs = ladderFor(config);
        Exception last = null;

        for (MailSender.Endpoint endpoint : rungs) {
            Store store = null;
            Folder inbox = null;
            try {
                Session session = buildSession(config, endpoint);
                store = session.getStore("imap");
                store.connect(host, endpoint.port, username, secret);

                inbox = store.getFolder("INBOX");
                inbox.open(folderMode);

                return body.run(store, inbox);
            } catch (Exception e) {
                last = e;
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                if (!MailSender.negotiable(MailSender.classify(message))) break;
            } finally {
                try {
                    if (inbox != null && inbox.isOpen()) inbox.close(false);
                } catch (Exception ignored) {
                }
                try {
                    if (store != null) store.close();
                } catch (Exception ignored) {
                }
            }
        }

        throw last != null ? last : new IllegalStateException("Could not connect to the IMAP server");
    }

    // -----------------------------------------------------------------------
    // Connection test
    // -----------------------------------------------------------------------

    /**
     * Open INBOX read-only and report what the server says about it.
     *
     * The counterpart of {@link MailSender#test}, and shaped identically so
     * the same UI renders both. It reports message counts as well as "it
     * connected", because a mailbox that opens but shows zero messages is a
     * different problem from one that will not open at all, and on screen the
     * two are otherwise indistinguishable.
     */
    static MailSender.Result test(JSONObject config, String secret) {
        long started = System.currentTimeMillis();
        MailSender.Result result = new MailSender.Result();

        if (TextUtils.isEmpty(config.optString("imapHost", ""))) {
            result.ok = false;
            result.error = "No IMAP server set";
            result.errorKind = "config";
            return result;
        }
        if (TextUtils.isEmpty(secret)) {
            result.ok = false;
            result.error = "No password stored for receiving";
            result.errorKind = "auth";
            return result;
        }

        try {
            JSONObject counts = withInbox(config, secret, Folder.READ_ONLY, (store, inbox) -> {
                JSONObject o = new JSONObject();
                o.put("total", inbox.getMessageCount());
                o.put("unseen", inbox.getUnreadMessageCount());
                return o;
            });

            result.ok = true;
            result.durationMs = System.currentTimeMillis() - started;
            result.mailbox = counts;

            JSONObject diagnostics = new JSONObject();
            diagnostics.put("host", config.optString("imapHost", ""));
            diagnostics.put("port", config.optInt("imapPort", 993));
            diagnostics.put("securityUsed", config.optString("imapSecurity", "ssl"));
            diagnostics.put("stage", "done");
            diagnostics.put("attempts", 1);
            result.diagnostics = diagnostics;
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            result.ok = false;
            result.durationMs = System.currentTimeMillis() - started;
            result.error = message;
            result.errorKind = MailSender.classify(message);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Sync — headers for the most recent messages
    // -----------------------------------------------------------------------

    /**
     * Fetch envelope data for the most recent {@link #LIST_LIMIT} messages and
     * merge it into whatever the caller already had cached, then prefetch a
     * bounded number of bodies for messages that do not have one yet.
     *
     * Returns the updated `InboxAccountState` JSON — same shape `syncInbox`
     * returns on the desktop, so `bridge-android.ts` needs no translation.
     */
    static JSONObject sync(android.content.Context context, JSONObject config, String secret) throws Exception {
        final String accountId = config.optString("accountId", "");
        JSONArray previousMessagesRaw = config.optJSONArray("messages");
        final JSONArray previousMessages = previousMessagesRaw == null ? new JSONArray() : previousMessagesRaw;

        return withInbox(config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            long uidValidity = uidFolder.getUIDValidity();

            // A changed UIDVALIDITY means every cached UID for this folder is
            // stale — the server is free to reuse UIDs after that point, so a
            // cached body could silently belong to a different message.
            JSONArray priorForThisFolder = uidValidity == config.optLong("imapUidValidity", -1)
                    ? previousMessages
                    : new JSONArray();

            int total = inbox.getMessageCount();

            // "The mailbox is empty" is the one answer worth confirming before
            // acting on, because acting on it discards every cached message.
            // Observed on the desktop against Gmail: a mailbox that had just
            // reported 35 messages came back empty, with no error at all.
            //
            // getMessageCount() returns the EXISTS from SELECT; the unread
            // count is answered separately by the server, so the two
            // disagreeing means one of them is wrong and neither is worth
            // deleting mail over. Both agreeing on zero is a mailbox the user
            // really did empty. Showing briefly stale mail costs nothing;
            // losing it costs the feature.
            if (total == 0 && previousMessages.length() > 0 && inbox.getUnreadMessageCount() > 0) {
                JSONObject unchanged = new JSONObject(config.toString());
                unchanged.put("lastSyncAt", System.currentTimeMillis());
                unchanged.remove("lastSyncError");
                return unchanged;
            }

            int start = Math.max(1, total - LIST_LIMIT + 1);
            Message[] range = total > 0 ? inbox.getMessages(start, total) : new Message[0];

            javax.mail.FetchProfile profile = new javax.mail.FetchProfile();
            profile.add(javax.mail.FetchProfile.Item.ENVELOPE);
            profile.add(javax.mail.FetchProfile.Item.FLAGS);
            profile.add(UIDFolder.FetchProfileItem.UID);
            if (range.length > 0) inbox.fetch(range, profile);

            JSONArray messages = new JSONArray();
            int unread = 0;
            int bodiesFetched = 0;

            // Newest first, matching how the inbox view lists them.
            for (int i = range.length - 1; i >= 0; i--) {
                Message m = range[i];
                long uid = uidFolder.getUID(m);
                boolean seen = m.isSet(Flags.Flag.SEEN);
                if (!seen) unread++;

                JSONObject prior = findByUid(priorForThisFolder, uid);
                JSONObject row = prior != null ? prior : new JSONObject();
                row.put("id", accountId + ":INBOX:" + uid);
                row.put("accountId", accountId);
                row.put("folderPath", "INBOX");
                row.put("uid", uid);
                row.put("uidValidity", uidValidity);
                row.put("from", formatAddresses(m.getFrom()));
                row.put("to", formatAddresses(m.getRecipients(Message.RecipientType.TO)));
                row.put("subject", nullToEmpty(m.getSubject()));
                row.put("date", m.getSentDate() != null ? m.getSentDate().getTime() : System.currentTimeMillis());
                row.put("sizeBytes", Math.max(0, m.getSize()));
                row.put("hasAttachments", hasAttachments(m));
                row.put("seen", seen);
                if (!row.has("tag")) row.put("tag", "none");
                if (!row.has("snippet")) row.put("snippet", "");
                boolean alreadyCached = row.optBoolean("bodyCached", false)
                        || InboxBodyStore.hasBody(context, accountId, "INBOX", uid);
                row.put("bodyCached", alreadyCached);

                messages.put(row);

                if (!alreadyCached && bodiesFetched < BODY_PREFETCH_LIMIT) {
                    bodiesFetched++;
                    try {
                        Parsed parsed = extract(m);
                        InboxBodyStore.writeBody(context, accountId, "INBOX", uid, parsed.toBodyJson());
                        row.put("snippet", snippetOf(parsed));
                        row.put("bodyCached", true);
                    } catch (Exception ignored) {
                        // A body that fails to parse is not fatal to the sync —
                        // it just loads on demand later like an unprefetched one.
                    }
                }
            }

            JSONObject folder = new JSONObject();
            folder.put("id", accountId + ":INBOX");
            folder.put("accountId", accountId);
            folder.put("path", "INBOX");
            folder.put("displayName", "INBOX");
            folder.put("uidValidity", uidValidity);
            folder.put("unreadCount", unread);
            folder.put("totalCount", total);

            JSONObject result = new JSONObject(config.toString());
            result.put("messages", messages);
            result.put("folders", new JSONArray().put(folder));
            result.put("imapUidValidity", uidValidity);
            result.put("lastSyncAt", System.currentTimeMillis());
            result.remove("lastSyncError");
            return result;
        });
    }

    // -----------------------------------------------------------------------
    // Body fetch (on demand, for a message that was not prefetched)
    // -----------------------------------------------------------------------

    static JSONObject fetchBody(android.content.Context context, JSONObject config, String secret,
                                 String folderPath, long uid) throws Exception {
        JSONObject cached = InboxBodyStore.readBody(context, config.optString("accountId", ""), folderPath, uid);
        if (cached != null) return cached;

        return withInbox(config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m == null) throw new IllegalStateException("Message not found");
            Parsed parsed = extract(m);
            JSONObject body = parsed.toBodyJson();
            InboxBodyStore.writeBody(context, config.optString("accountId", ""), folderPath, uid, body);
            return body;
        });
    }

    static void setSeen(JSONObject config, String secret, String folderPath, long uid, boolean seen)
            throws Exception {
        withInbox(config, secret, Folder.READ_WRITE, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m != null) inbox.setFlags(new Message[]{m}, new Flags(Flags.Flag.SEEN), seen);
            return null;
        });
    }

    // -----------------------------------------------------------------------
    // MIME parsing — deliberately narrow: text/plain, text/html, and one level
    // of multipart/alternative or multipart/mixed. Real verification and
    // login-link mail is almost never anything more exotic than this, and a
    // part this code does not understand is skipped rather than crashing the
    // whole sync.
    // -----------------------------------------------------------------------

    private static final class Parsed {
        String text;
        String html;
        final List<JSONObject> attachments = new ArrayList<>();

        JSONObject toBodyJson() throws Exception {
            JSONObject o = new JSONObject();
            if (text != null) o.put("text", text);
            if (html != null) {
                JSONObject sanitized = InboxSanitizer.sanitize(html);
                o.put("sanitizedHtml", sanitized.getString("html"));
                o.put("remoteImages", sanitized.getJSONArray("remoteImages"));
            }
            JSONArray atts = new JSONArray();
            for (JSONObject a : attachments) atts.put(a);
            o.put("attachments", atts);
            return o;
        }
    }

    private static Parsed extract(Message message) throws Exception {
        Parsed parsed = new Parsed();
        Object content = message.getContent();
        if (content instanceof String) {
            if (message.isMimeType("text/html")) {
                parsed.html = (String) content;
            } else {
                parsed.text = (String) content;
            }
        } else if (content instanceof Multipart) {
            walk((Multipart) content, parsed);
        }
        return parsed;
    }

    private static void walk(Multipart multipart, Parsed parsed) throws Exception {
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            boolean attachment = Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"));

            if (attachment) {
                addAttachment(part, parsed.attachments);
                continue;
            }
            if (part.isMimeType("text/plain") && parsed.text == null) {
                parsed.text = (String) part.getContent();
            } else if (part.isMimeType("text/html") && parsed.html == null) {
                parsed.html = (String) part.getContent();
            } else if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) walk((Multipart) nested, parsed);
            }
        }
    }

    private static void addAttachment(BodyPart part, List<JSONObject> attachments) {
        try {
            long size = part.getSize();
            if (size > ATTACHMENT_MAX_BYTES) return;

            String name = part.getFileName();
            if (name != null) name = MimeUtility.decodeText(name);
            JSONObject a = new JSONObject();
            a.put("id", "att_" + System.nanoTime());
            a.put("name", name == null ? "attachment" : name);
            a.put("size", Math.max(0, size));
            a.put("mime", part.getContentType());
            a.put("inline", false);
            // Content is not persisted here — the message body cache stores
            // metadata only; attachments download on demand the same way a
            // prefetch-skipped message body does, matching the desktop's
            // PREFETCH_MAX_BYTES philosophy of bounding what a sync pays for
            // up front.
            a.put("source", "imap");
            // Empty until downloaded. Present rather than absent so the JS
            // `Attachment` shape is the same on both platforms and the reader
            // does not need to know which one it is running on.
            a.put("path", "");
            // The stable handle a later download works from — an ordinal over
            // *attachments only*, in document order. `id` cannot serve: it is
            // minted per parse, so a body read back from the on-disk cache
            // would carry an id that names nothing on the server.
            a.put("partIndex", attachments.size());
            attachments.add(a);
        } catch (Exception ignored) {
        }
    }

    // -----------------------------------------------------------------------
    // Attachment download (on demand)
    // -----------------------------------------------------------------------

    /**
     * Fetch one attachment's bytes and put them on disk.
     *
     * Deliberately separate from {@link #fetchBody}: a sync that eagerly
     * downloaded every attachment on every message would spend a phone's data
     * allowance on files nobody opened. The body cache lists what is there;
     * this is what happens when somebody actually taps one.
     *
     * Idempotent — an attachment already on disk is returned without opening a
     * connection at all, which is what makes "preview, then save, then open"
     * three taps rather than three downloads.
     *
     * @return {@code {name, size, mime, path}} for the file that now exists.
     */
    static JSONObject downloadAttachment(android.content.Context context, JSONObject config,
                                         String secret, String folderPath, long uid,
                                         int partIndex, String fallbackName) throws Exception {
        File dir = new File(DataRoot.dir(context), "inbox-attachments" + File.separator
                + safeSegment(config.optString("accountId", "")) + File.separator
                + safeSegment(folderPath) + File.separator + uid);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Could not create the attachment directory");
        }

        File existing = findExisting(dir, partIndex);
        if (existing != null) return describe(existing, fallbackName);

        return withInbox(config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m == null) throw new IllegalStateException("Message not found");

            List<BodyPart> parts = new ArrayList<>();
            Object content = m.getContent();
            if (content instanceof Multipart) collectAttachmentParts((Multipart) content, parts);
            if (partIndex < 0 || partIndex >= parts.size()) {
                throw new IllegalStateException("That attachment is no longer on the message");
            }

            BodyPart part = parts.get(partIndex);
            String name = part.getFileName();
            if (name != null) name = MimeUtility.decodeText(name);
            if (name == null || name.isEmpty()) name = fallbackName;

            File target = new File(dir, partIndex + "_" + safeSegment(name));
            try (InputStream in = part.getInputStream();
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                long total = 0;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    total += read;
                    if (total > ATTACHMENT_MAX_BYTES) {
                        throw new IllegalStateException("That attachment is too large to download");
                    }
                }
            } catch (Exception e) {
                // Never leave a half-written file behind: it would be treated
                // as a completed download by the `findExisting` check above,
                // and every later tap would open a truncated file rather than
                // retrying.
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                throw e;
            }
            return describe(target, name);
        });
    }

    /** Attachment parts of a message, in the same order {@link #walk} counts them. */
    private static void collectAttachmentParts(Multipart multipart, List<BodyPart> out)
            throws Exception {
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            boolean attachment = Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"));
            if (attachment) {
                out.add(part);
                continue;
            }
            if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) collectAttachmentParts((Multipart) nested, out);
            }
        }
    }

    private static File findExisting(File dir, int partIndex) {
        File[] children = dir.listFiles();
        if (children == null) return null;
        String prefix = partIndex + "_";
        for (File child : children) {
            if (child.isFile() && child.getName().startsWith(prefix)) return child;
        }
        return null;
    }

    private static JSONObject describe(File file, String name) throws Exception {
        JSONObject o = new JSONObject();
        o.put("name", name);
        o.put("size", file.length());
        o.put("path", file.getAbsolutePath());
        o.put("mime", guessMime(file.getName()));
        return o;
    }

    /** Strip anything that could escape the directory we intend to write into. */
    private static String safeSegment(String value) {
        String base = new File(value == null ? "" : value).getName();
        String cleaned = base.replaceAll("[^A-Za-z0-9._\\-]", "_");
        return cleaned.isEmpty() ? "_" : cleaned;
    }

    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
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
            default: return "application/octet-stream";
        }
    }

    private static String formatAddresses(Address[] addresses) {
        if (addresses == null || addresses.length == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (Address a : addresses) {
            if (sb.length() > 0) sb.append(", ");
            if (a instanceof InternetAddress) {
                InternetAddress ia = (InternetAddress) a;
                sb.append(TextUtils.isEmpty(ia.getPersonal()) ? ia.getAddress() : ia.getPersonal());
            } else {
                sb.append(a.toString());
            }
        }
        return sb.toString();
    }

    private static boolean hasAttachments(Message message) {
        try {
            Object content = message.getContent();
            if (!(content instanceof Multipart)) return false;
            return countAttachments((Multipart) content) > 0;
        } catch (Exception e) {
            return false;
        }
    }

    private static int countAttachments(Multipart multipart) throws Exception {
        int count = 0;
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            if (Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"))) {
                count++;
            } else if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) count += countAttachments((Multipart) nested);
            }
        }
        return count;
    }

    private static String snippetOf(Parsed parsed) {
        String source = parsed.text != null ? parsed.text
                : parsed.html != null ? parsed.html.replaceAll("<[^>]+>", " ") : "";
        String collapsed = source.replaceAll("\\s+", " ").trim();
        return collapsed.length() > 180 ? collapsed.substring(0, 180) : collapsed;
    }

    private static JSONObject findByUid(JSONArray messages, long uid) {
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null && m.optLong("uid", -1) == uid) return m;
        }
        return null;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
