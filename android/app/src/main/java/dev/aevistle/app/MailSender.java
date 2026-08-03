package dev.aevistle.app;

import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.regex.Pattern;

import javax.activation.DataHandler;
import javax.activation.FileDataSource;
import javax.mail.Authenticator;
import javax.mail.BodyPart;
import javax.mail.Message;
import javax.mail.Multipart;
import javax.mail.PasswordAuthentication;
import javax.mail.Session;
import javax.mail.Transport;
import javax.mail.internet.InternetAddress;
import javax.mail.internet.MimeBodyPart;
import javax.mail.internet.MimeMessage;
import javax.mail.internet.MimeMultipart;

/**
 * SMTP on Android, via JavaMail.
 *
 * Mirrors `electron/mailer.ts` deliberately: the same validation, the same
 * error classification, the same result shape. When a user reports "it works
 * on my PC but not my phone", the answer should never be that the two builds
 * disagree about what a valid message is.
 */
final class MailSender {

    /** Same character class the TypeScript side rejects — CR, LF, NUL and friends. */
    private static final Pattern CONTROL_CHARS =
            Pattern.compile("[\\r\\n\\u0000\\u000b\\u000c\\u2028\\u2029]");

    private static final Pattern ADDRESS = Pattern.compile(
            "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*" +
            "@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$");

    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.\\-_]+$");

    static class Result {
        boolean ok;
        String messageId;
        final List<String> accepted = new ArrayList<>();
        final List<String> rejected = new ArrayList<>();
        long durationMs;
        String error;
        String errorKind;
        /** Which endpoint answered, so the UI can offer to adopt it. */
        JSONObject diagnostics;
        /** Inbox tests only: {total, unseen} as reported by the server. */
        JSONObject mailbox;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", ok);
                if (messageId != null) o.put("messageId", messageId);
                o.put("accepted", new JSONArray(accepted));
                o.put("rejected", new JSONArray(rejected));
                o.put("durationMs", durationMs);
                if (error != null) o.put("error", error);
                if (errorKind != null) o.put("errorKind", errorKind);
                if (diagnostics != null) o.put("diagnostics", diagnostics);
                if (mailbox != null) o.put("mailbox", mailbox);
            } catch (Exception ignored) {
            }
            return o;
        }
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    private static boolean headerSafe(String value) {
        return value == null || !CONTROL_CHARS.matcher(value).find();
    }

    private static boolean validAddress(String address) {
        if (TextUtils.isEmpty(address)) return false;
        String a = address.trim();
        return a.length() <= 254 && headerSafe(a) && ADDRESS.matcher(a).matches();
    }

    /**
     * Kept in sync with `classifyError` in src/core/bridge.ts.
     *
     * Order matters in the same way it does there: a connection the server
     * dropped mid-handshake contains the word "socket" and would otherwise be
     * filed as a network fault, sending the user off to check their Wi-Fi when
     * the actual fix is a different port.
     */
    static String classify(String message) {
        String m = message == null ? "" : message.toLowerCase();
        if (m.matches(".*(auth|535|534|password|credential|login|授权码).*")) return "auth";
        if (m.matches(".*(unexpected socket close|connection reset|broken pipe|handshake|wrong version number|eof).*")) return "handshake";
        if (m.matches(".*(timed out|timeout|no answer from the server).*")) return "timeout";
        if (m.matches(".*(certificate|self-signed|self signed|tls|ssl|unable to find valid certification).*")) return "tls";
        if (m.matches(".*(unknownhost|connection refused|network|dns|unreachable|socket).*")) return "network";
        if (m.matches(".*(550|551|553|recipient|no such user|mailbox unavailable).*")) return "recipient";
        if (m.matches(".*(552|quota|exceeded|too large|message size).*")) return "quota";
        if (m.matches(".*(no such file|permission denied|enoent).*")) return "attachment";
        if (m.matches(".*(invalid|missing|required|port|host).*")) return "config";
        return "unknown";
    }

    // -----------------------------------------------------------------------
    // Endpoint ladder
    //
    // Mirrors src/core/transport.ts. Kept as a duplicate rather than shared
    // because the alternative is a JS round trip from a background worker that
    // runs when no WebView exists — and the rule it encodes (465 and 587 are
    // the same service on nearly every provider) is four lines long.
    // -----------------------------------------------------------------------

    static final class Endpoint {
        final int port;
        final String security;

        Endpoint(int port, String security) {
            this.port = port;
            this.security = security;
        }

        boolean same(Endpoint other) {
            return port == other.port && security.equals(other.security);
        }
    }

    static List<Endpoint> ladder(int port, String security, boolean autoNegotiate) {
        List<Endpoint> out = new ArrayList<>();
        out.add(new Endpoint(port, security));
        if (!autoNegotiate) return out;

        List<Endpoint> alternatives = new ArrayList<>();
        if (port == 465 || port == 8465) {
            alternatives.add(new Endpoint(587, "starttls"));
            alternatives.add(new Endpoint(port, "starttls"));
        } else if (port == 587 || port == 25 || port == 2525 || port == 1025) {
            alternatives.add(new Endpoint(465, "ssl"));
            alternatives.add(new Endpoint(port, "ssl"));
        } else {
            alternatives.add(new Endpoint(port, "ssl".equals(security) ? "starttls" : "ssl"));
        }

        for (Endpoint candidate : alternatives) {
            if (out.size() >= 3) break;
            // Never downgrade to plaintext on the user's behalf.
            if ("none".equals(candidate.security) && !"none".equals(security)) continue;
            boolean seen = false;
            for (Endpoint existing : out) {
                if (existing.same(candidate)) { seen = true; break; }
            }
            if (!seen) out.add(candidate);
        }
        return out;
    }

    /** Whether a different endpoint could plausibly fix this failure. */
    static boolean negotiable(String kind) {
        return "handshake".equals(kind) || "tls".equals(kind)
                || "timeout".equals(kind) || "network".equals(kind);
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    private static Session buildSession(JSONObject account, final String secret, Endpoint endpoint)
            throws Exception {
        String host = account.optString("host", "");
        int port = endpoint.port;
        String security = endpoint.security;
        final String username = account.optString("username", "");
        boolean allowInvalidCert = account.optBoolean("allowInvalidCert", false);
        // Per *attempt*, not for the whole operation — the ladder below owns
        // the total, so one unresponsive port cannot spend all of the user's
        // patience by itself.
        int timeout = Math.min(Math.max(account.optInt("timeoutMs", 20000) / 2, 8000), 15000);

        if (!HOST.matcher(host).matches()) throw new IllegalArgumentException("Invalid SMTP host");
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid SMTP port");

        Properties props = new Properties();
        props.put("mail.smtp.host", host);
        props.put("mail.smtp.port", String.valueOf(port));
        props.put("mail.smtp.connectiontimeout", String.valueOf(timeout));
        props.put("mail.smtp.timeout", String.valueOf(Math.max(timeout, 60000)));
        props.put("mail.smtp.writetimeout", String.valueOf(Math.max(timeout, 60000)));
        props.put("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3");

        if ("ssl".equals(security)) {
            props.put("mail.smtp.ssl.enable", "true");
        } else if ("starttls".equals(security)) {
            props.put("mail.smtp.starttls.enable", "true");
            props.put("mail.smtp.starttls.required", "true");
        }

        if (allowInvalidCert) {
            // Explicit opt-in only; the UI paints this switch red and says why.
            props.put("mail.smtp.ssl.trust", "*");
            props.put("mail.smtp.ssl.checkserveridentity", "false");
        } else {
            props.put("mail.smtp.ssl.checkserveridentity", "true");
        }

        boolean auth = "password".equals(account.optString("authMethod", "password"))
                && !TextUtils.isEmpty(secret);
        props.put("mail.smtp.auth", auth ? "true" : "false");

        if (!auth) return Session.getInstance(props);

        return Session.getInstance(props, new Authenticator() {
            @Override
            protected PasswordAuthentication getPasswordAuthentication() {
                return new PasswordAuthentication(username, secret);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Send
    // -----------------------------------------------------------------------

    /**
     * Where the app is willing to walk the ladder.
     *
     * Every endpoint on it gets a fair try, and the caller always gets an
     * answer — a spinner that never resolves is the single worst outcome here.
     */
    private static List<Endpoint> laddderFor(JSONObject account) {
        return ladder(
                account.optInt("port", 465),
                account.optString("security", "ssl"),
                account.optBoolean("autoNegotiate", true));
    }

    private static void recordEndpoint(Result result, JSONObject account, Endpoint endpoint,
                                       int attempts, String stage) {
        result.diagnostics = new JSONObject();
        try {
            result.diagnostics.put("securityUsed", endpoint.security);
            result.diagnostics.put("port", endpoint.port);
            result.diagnostics.put("host", account.optString("host", ""));
            result.diagnostics.put("stage", stage);
            result.diagnostics.put("attempts", attempts);
            result.diagnostics.put("adjusted",
                    endpoint.port != account.optInt("port", 465)
                            || !endpoint.security.equals(account.optString("security", "ssl")));
        } catch (Exception ignored) {
        }
    }

    static Result send(JSONObject draft, JSONObject account, String secret) {
        long started = System.currentTimeMillis();
        Result result = new Result();

        try {
            String fromAddress = account.optString("fromAddress", "");
            String fromName = account.optString("fromName", "");
            String subject = draft.optString("subject", "");

            if (!validAddress(fromAddress)) throw new IllegalArgumentException("Invalid from address");
            if (!headerSafe(fromName)) throw new IllegalArgumentException("Invalid sender name");
            if (!headerSafe(subject)) throw new IllegalArgumentException("Subject contains an illegal character");

            List<String> to = readList(draft, "to");
            List<String> cc = readList(draft, "cc");
            List<String> bcc = readList(draft, "bcc");

            List<String> everyone = new ArrayList<>();
            everyone.addAll(to);
            everyone.addAll(cc);
            everyone.addAll(bcc);
            if (everyone.isEmpty()) throw new IllegalArgumentException("No recipients");
            for (String address : everyone) {
                if (!validAddress(address)) throw new IllegalArgumentException("Invalid recipient: " + address);
            }

            List<Endpoint> rungs = laddderFor(account);
            Exception last = null;
            int attempts = 0;

            for (Endpoint endpoint : rungs) {
                attempts++;
                try {
                    Session session = buildSession(account, secret, endpoint);

                    if (draft.optBoolean("individualDelivery", false)) {
                        for (String address : everyone) {
                            MimeMessage message =
                                    compose(session, draft, account, single(address), null, null);
                            Transport.send(message);
                            result.accepted.add(address);
                            result.messageId = message.getMessageID();
                        }
                    } else {
                        MimeMessage message = compose(session, draft, account, to, cc, bcc);
                        Transport.send(message);
                        result.accepted.addAll(everyone);
                        result.messageId = message.getMessageID();
                    }

                    result.ok = true;
                    recordEndpoint(result, account, endpoint, attempts, "done");
                    last = null;
                    break;
                } catch (Exception e) {
                    last = e;
                    String message = e.getMessage() == null ? e.toString() : e.getMessage();
                    // A rejected password is rejected on every port; retrying
                    // it only burns the provider's lockout budget.
                    if (!negotiable(classify(message))) break;
                    // Partial progress from a failed rung must not leak into
                    // the next one's tally.
                    result.accepted.clear();
                    result.rejected.clear();
                }
            }

            if (last != null) throw last;
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            result.ok = false;
            result.accepted.clear();
            result.error = message;
            result.errorKind = classify(message);
        }

        result.durationMs = System.currentTimeMillis() - started;
        return result;
    }

    /**
     * Connect and authenticate without sending anything.
     *
     * Walks the same ladder as {@link #send}, and always returns: the previous
     * version could sit inside a single {@code connect()} for as long as the
     * network cared to keep it there, which is what left the dialog stuck on
     * "Testing…" with nothing to press.
     */
    static Result test(JSONObject account, String secret) {
        long started = System.currentTimeMillis();
        Result result = new Result();

        List<Endpoint> rungs;
        try {
            rungs = laddderFor(account);
        } catch (Exception e) {
            result.error = String.valueOf(e.getMessage());
            result.errorKind = classify(result.error);
            result.durationMs = System.currentTimeMillis() - started;
            return result;
        }

        String lastError = "No connection attempt was made";
        int attempts = 0;
        Endpoint lastEndpoint = rungs.get(rungs.size() - 1);

        for (Endpoint endpoint : rungs) {
            attempts++;
            Transport transport = null;
            try {
                Session session = buildSession(account, secret, endpoint);
                transport = session.getTransport("smtp");
                transport.connect(
                        account.optString("host", ""),
                        endpoint.port,
                        account.optString("username", ""),
                        secret);
                result.ok = true;
                recordEndpoint(result, account, endpoint, attempts, "done");
                result.durationMs = System.currentTimeMillis() - started;
                return result;
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                lastEndpoint = endpoint;
                if (!negotiable(classify(lastError))) break;
            } finally {
                if (transport != null) {
                    try {
                        transport.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        result.ok = false;
        result.error = lastError;
        result.errorKind = classify(lastError);
        recordEndpoint(result, account, lastEndpoint, attempts,
                "auth".equals(result.errorKind) ? "auth" : "connect");
        result.durationMs = System.currentTimeMillis() - started;
        return result;
    }

    // -----------------------------------------------------------------------
    // Message assembly
    // -----------------------------------------------------------------------

    private static MimeMessage compose(
            Session session,
            JSONObject draft,
            JSONObject account,
            List<String> to,
            List<String> cc,
            List<String> bcc) throws Exception {

        MimeMessage message = new MimeMessage(session);

        String fromName = account.optString("fromName", "");
        String fromAddress = account.optString("fromAddress", "");
        message.setFrom(TextUtils.isEmpty(fromName)
                ? new InternetAddress(fromAddress)
                : new InternetAddress(fromAddress, fromName, "UTF-8"));

        String replyTo = account.optString("replyTo", "");
        if (!TextUtils.isEmpty(replyTo) && validAddress(replyTo)) {
            message.setReplyTo(new InternetAddress[]{new InternetAddress(replyTo)});
        }

        addRecipients(message, Message.RecipientType.TO, to);
        addRecipients(message, Message.RecipientType.CC, cc);
        addRecipients(message, Message.RecipientType.BCC, bcc);

        message.setSubject(draft.optString("subject", ""), "UTF-8");
        message.setSentDate(new java.util.Date());

        String priority = draft.optString("priority", "normal");
        if ("high".equals(priority)) {
            message.setHeader("X-Priority", "1");
            message.setHeader("Importance", "High");
        } else if ("low".equals(priority)) {
            message.setHeader("X-Priority", "5");
            message.setHeader("Importance", "Low");
        }
        if (draft.optBoolean("requestReadReceipt", false)) {
            message.setHeader("Disposition-Notification-To", fromAddress);
        }

        String body = draft.optString("body", "");
        boolean isHtml = "html".equals(draft.optString("bodyFormat", "plain"));
        JSONArray attachments = draft.optJSONArray("attachments");

        if (attachments == null || attachments.length() == 0) {
            if (isHtml) {
                message.setContent(body, "text/html; charset=UTF-8");
            } else {
                message.setText(body, "UTF-8");
            }
        } else {
            Multipart multipart = new MimeMultipart();

            BodyPart textPart = new MimeBodyPart();
            if (isHtml) {
                textPart.setContent(body, "text/html; charset=UTF-8");
            } else {
                textPart.setText(body);
            }
            multipart.addBodyPart(textPart);

            for (int i = 0; i < attachments.length(); i++) {
                JSONObject a = attachments.optJSONObject(i);
                if (a == null) continue;

                String name = a.optString("name", "attachment");
                if (!headerSafe(name)) throw new IllegalArgumentException("Illegal attachment name: " + name);

                File file = new File(a.optString("path", ""));
                if (!file.isFile()) throw new IllegalStateException("Attachment not found: " + name);

                MimeBodyPart part = new MimeBodyPart();
                part.setDataHandler(new DataHandler(new FileDataSource(file)));
                // Strip any directory component from the declared name so the
                // receiving client cannot be talked into writing outside its
                // own download folder.
                part.setFileName(javax.mail.internet.MimeUtility.encodeText(
                        new File(name).getName(), "UTF-8", null));
                if (a.optBoolean("inline", false) && !TextUtils.isEmpty(a.optString("cid", ""))) {
                    part.setHeader("Content-ID", "<" + a.optString("cid") + ">");
                    part.setDisposition(javax.mail.Part.INLINE);
                }
                multipart.addBodyPart(part);
            }

            message.setContent(multipart);
        }

        message.saveChanges();
        return message;
    }

    private static void addRecipients(MimeMessage message, Message.RecipientType type, List<String> addresses)
            throws Exception {
        if (addresses == null || addresses.isEmpty()) return;
        InternetAddress[] parsed = new InternetAddress[addresses.size()];
        for (int i = 0; i < addresses.size(); i++) {
            parsed[i] = new InternetAddress(addresses.get(i));
        }
        message.setRecipients(type, parsed);
    }

    private static List<String> readList(JSONObject source, String key) {
        List<String> out = new ArrayList<>();
        JSONArray array = source.optJSONArray(key);
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "").trim();
            if (!value.isEmpty()) out.add(value);
        }
        return out;
    }

    private static List<String> single(String value) {
        List<String> list = new ArrayList<>(1);
        list.add(value);
        return list;
    }
}
