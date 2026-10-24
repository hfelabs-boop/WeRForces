package org.werforces.hla;

import java.io.File;
import java.net.URISyntaxException;
import java.util.LinkedHashMap;
import java.util.Map;

/** Command-line options of the bridge. */
final class Config {
  String rtiHost = "localhost";
  int rtiPort = 15000;
  /** True when --rti-host or --rti-port was given. */
  boolean rtiAddressGiven;
  /** Passed verbatim to RTIambassador.connect when set; overrides rtiHost/rtiPort. */
  String rtiSettings;
  String federation = "WeRForces";
  String federateName = "WeRForcesBridge";
  String federateType = "WeRForcesDisBridge";
  String fom;
  String disBind = "0.0.0.0";
  int disPort = 3000;
  String disAddress = "255.255.255.255";
  int disSendPort = -1;
  int exercise = 1;
  int site = 1;
  int application = 3100;
  double heartbeat = 5;
  double refresh = 10;
  double timeout = 12;
  boolean verbose;

  static final String USAGE = """
      Usage: java -jar werforces-hla-bridge.jar [options]

      HLA (IEEE 1516e) side:
        --rti-host <host>         RTI host (localhost)
        --rti-port <port>         RTI port (15000)
        --rti-settings <string>   Local settings designator passed verbatim to connect();
                                  overrides --rti-host/--rti-port (e.g. "crcAddress=host:8989" for Pitch)
        --federation <name>       Federation execution, created if missing (WeRForces)
        --federate <name>         Federate name (WeRForcesBridge)
        --fom <file>              FOM module (hla/fom/werforces-rpr.xml)
        --refresh <s>             Seconds between full attribute refreshes of DIS entities (10)

      DIS side:
        --dis-port <port>         UDP port to listen on (3000)
        --dis-bind <addr>         Interface to listen on (0.0.0.0)
        --dis-address <addr>      Destination for PDUs: broadcast, multicast group or host (255.255.255.255)
        --dis-send-port <port>    Destination port (same as --dis-port)
        --exercise <id>           DIS exercise (1)
        --site <n>                DIS site for entities reflected from HLA (1)
        --application <n>         DIS application for entities reflected from HLA (3100)
        --heartbeat <s>           Entity State heartbeat for entities reflected from HLA (5)
        --timeout <s>             Seconds without an Entity State before a DIS entity is deleted (12)

        --verbose                 Log every bridged object and interaction
      """;

  static Config parse(String[] args) {
    Map<String, String> opts = new LinkedHashMap<>();
    Config c = new Config();
    for (int i = 0; i < args.length; i++) {
      String a = args[i];
      if (a.equals("--help") || a.equals("-h")) {
        System.out.print(USAGE);
        System.exit(0);
      }
      if (a.equals("--verbose")) {
        c.verbose = true;
        continue;
      }
      if (!a.startsWith("--") || i + 1 >= args.length) throw new IllegalArgumentException("bad argument " + a + "\n\n" + USAGE);
      opts.put(a.substring(2), args[++i]);
    }
    for (Map.Entry<String, String> e : opts.entrySet()) {
      String v = e.getValue();
      switch (e.getKey()) {
        case "rti-host" -> {
          c.rtiHost = v;
          c.rtiAddressGiven = true;
        }
        case "rti-port" -> {
          c.rtiPort = Integer.parseInt(v);
          c.rtiAddressGiven = true;
        }
        case "rti-settings" -> c.rtiSettings = v;
        case "federation" -> c.federation = v;
        case "federate" -> c.federateName = v;
        case "fom" -> c.fom = v;
        case "refresh" -> c.refresh = Double.parseDouble(v);
        case "dis-port" -> c.disPort = Integer.parseInt(v);
        case "dis-bind" -> c.disBind = v;
        case "dis-address" -> c.disAddress = v;
        case "dis-send-port" -> c.disSendPort = Integer.parseInt(v);
        case "exercise" -> c.exercise = Integer.parseInt(v);
        case "site" -> c.site = Integer.parseInt(v);
        case "application" -> c.application = Integer.parseInt(v);
        case "heartbeat" -> c.heartbeat = Double.parseDouble(v);
        case "timeout" -> c.timeout = Double.parseDouble(v);
        default -> throw new IllegalArgumentException("unknown option --" + e.getKey() + "\n\n" + USAGE);
      }
    }
    if (c.disSendPort < 0) c.disSendPort = c.disPort;
    if (c.fom == null) c.fom = defaultFom();
    return c;
  }

  /** hla/fom/werforces-rpr.xml, found relative to the jar in hla/build/. */
  private static String defaultFom() {
    try {
      File jar = new File(Config.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      File fom = new File(jar.getParentFile().getParentFile(), "fom/werforces-rpr.xml");
      if (fom.isFile()) return fom.getPath();
    } catch (URISyntaxException | RuntimeException ignored) {
      // fall through
    }
    return "hla/fom/werforces-rpr.xml";
  }
}
