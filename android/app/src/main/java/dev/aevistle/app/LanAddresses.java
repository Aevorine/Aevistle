package dev.aevistle.app;

import java.net.InetAddress;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;

/**
 * Every address this device might be reachable at, best first.
 *
 * The Java half of `electron/pairingServer.ts`'s `listLanIPv4`, and kept
 * deliberately parallel to it — same exclusions, same ranking, same reason.
 * Both answers end up in the same place: a `PairingPayload.host` that the other
 * device dials by number, with no discovery protocol to correct a bad guess and
 * nothing but a four-second socket timeout to report one.
 *
 * A phone has fewer interfaces than a desktop, but not one. Wi-Fi, mobile data
 * and — the case that actually matters here — a Wi-Fi hotspot the phone is
 * itself serving are all up at once on a device that is tethering, and only one
 * of them is the network the laptop on the far side of the QR code is on. The
 * mobile-data address is the dangerous one: it is a routable, non-loopback
 * IPv4, `NetworkInterface` reports it exactly like the Wi-Fi card's, and it is
 * carrier-NATed so nothing on the LAN can reach it.
 *
 * So the ordering here is not the desktop's ordering with the names swapped:
 *
 *   - IPv4 only, and never loopback or link-local, same as the desktop.
 *   - `rmnet*`/`ccmni*`/`pdp*` — the vendor names for the cellular interface —
 *     sort last rather than being dropped, on the same reasoning the desktop
 *     applies to VPN tunnels: someone with an unusual setup should still be
 *     offered the address, just not handed it ahead of their Wi-Fi.
 *   - `ap*`/`swlan*`/`softap*` — the hotspot interface — sort *first* when
 *     present, because a phone that is running a hotspot is almost certainly
 *     pairing with something that joined it. `192.168.43.1` is the classic
 *     Android tethering address and the subnet ranking below already favours it.
 *   - Among equals the subnet decides, then the address, so the answer is
 *     stable between the QR code and the sync listener. An order that shifted
 *     between the two would pair on one address and then sync on another.
 */
final class LanAddresses {

    private LanAddresses() {}

    /** Interface-name prefixes for the cellular modem. Reachable by nobody on the LAN. */
    private static final String[] CELLULAR_HINTS = {"rmnet", "ccmni", "pdp", "clat", "wwan"};

    /** Interface-name prefixes for a hotspot this device is serving. */
    private static final String[] HOTSPOT_HINTS = {"ap0", "ap1", "swlan", "softap", "wlan1"};

    /** A candidate, with the two things the sort needs kept alongside it. */
    private static final class Candidate {
        final String address;
        /** Lower sorts first: hotspot 0, ordinary 1, cellular 2. */
        final int kind;
        final int subnet;

        Candidate(String address, int kind, int subnet) {
            this.address = address;
            this.kind = kind;
            this.subnet = subnet;
        }
    }

    static List<String> list() {
        List<Candidate> candidates = new ArrayList<>();
        Enumeration<NetworkInterface> interfaces;
        try {
            interfaces = NetworkInterface.getNetworkInterfaces();
        } catch (Exception e) {
            // No network stack to enumerate is the same answer as no network:
            // the caller reports "connect to Wi-Fi first" either way.
            return new ArrayList<>();
        }
        if (interfaces == null) return new ArrayList<>();

        while (interfaces.hasMoreElements()) {
            NetworkInterface nif = interfaces.nextElement();
            String name;
            try {
                if (!nif.isUp() || nif.isLoopback()) continue;
                name = nif.getName() == null ? "" : nif.getName().toLowerCase(Locale.ROOT);
            } catch (Exception e) {
                continue;
            }

            int kind = 1;
            if (startsWithAny(name, HOTSPOT_HINTS)) kind = 0;
            else if (startsWithAny(name, CELLULAR_HINTS)) kind = 2;

            Enumeration<InetAddress> addresses = nif.getInetAddresses();
            while (addresses != null && addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (!(address instanceof Inet4Address)) continue;
                if (address.isLoopbackAddress() || address.isAnyLocalAddress()) continue;
                String text = address.getHostAddress();
                if (text == null) continue;
                // Link-local: DHCP failed on this interface. Not a route anywhere.
                if (text.startsWith("169.254.")) continue;
                candidates.add(new Candidate(text, kind, subnetRank(text)));
            }
        }

        Collections.sort(candidates, new Comparator<Candidate>() {
            @Override
            public int compare(Candidate a, Candidate b) {
                if (a.kind != b.kind) return a.kind - b.kind;
                if (a.subnet != b.subnet) return a.subnet - b.subnet;
                return a.address.compareTo(b.address);
            }
        });

        List<String> out = new ArrayList<>(candidates.size());
        for (Candidate c : candidates) {
            if (!out.contains(c.address)) out.add(c.address);
        }
        return out;
    }

    /** The single best address, or null when this device is not on a network. */
    static String best() {
        List<String> all = list();
        return all.isEmpty() ? null : all.get(0);
    }

    /**
     * Is this an address this device actually holds?
     *
     * The allowlist for a caller-supplied bind address, and it exists for the
     * same reason `pairingServer.ts` keeps one: an unchecked override turns
     * `startPairingHost` into "bind wherever the WebView says", and the
     * interesting failure is not a bad literal but a name that resolves
     * somewhere.
     */
    static boolean holds(String address) {
        return address != null && list().contains(address);
    }

    private static boolean startsWithAny(String name, String[] prefixes) {
        for (String prefix : prefixes) {
            if (name.startsWith(prefix)) return true;
        }
        return false;
    }

    /** Lower sorts first. Mirrors `subnetRank` in `electron/pairingServer.ts`. */
    private static int subnetRank(String address) {
        if (address.startsWith("192.168.")) return 0;
        if (address.startsWith("10.")) return 1;
        String[] parts = address.split("\\.", -1);
        if (parts.length == 4) {
            try {
                int a = Integer.parseInt(parts[0]);
                int b = Integer.parseInt(parts[1]);
                if (a == 172 && b >= 16 && b <= 31) return 2;
            } catch (NumberFormatException ignored) {
            }
        }
        return 3;
    }
}
