package org.werforces.hla;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Turns --rti-host/--rti-port into the RTI-specific local settings designator that
 * IEEE 1516e RTIambassador.connect() takes. The standard leaves its format to the
 * RTI; --rti-settings bypasses this and passes a string verbatim.
 */
final class RtiSettings {
  private RtiSettings() {}

  static String designator(String rtiName, Config cfg) {
    if (cfg.rtiSettings != null) return cfg.rtiSettings;
    if (!cfg.rtiAddressGiven) return ""; // the RTI's own default
    String name = rtiName.toLowerCase();
    if (name.contains("ohla")) return ohla(cfg.rtiHost, cfg.rtiPort);
    if (name.contains("prti") || name.contains("pitch")) return "crcAddress=" + cfg.rtiHost + ":" + cfg.rtiPort;
    Bridge.warn("don't know how to pass --rti-host/--rti-port to " + rtiName + "; using its default settings (use --rti-settings)");
    return "";
  }

  /**
   * OHLA reads the designator as the name of a properties resource on the context
   * class loader, so write one to a temporary directory and put that on the loader.
   */
  private static String ohla(String host, int port) {
    try {
      Path dir = Files.createTempDirectory("werforces-hla");
      String resource = "werforces-ohla.properties";
      Path file = dir.resolve(resource);
      Files.writeString(file, "host=" + host + "\nport=" + port + "\nconnectTimeoutMillis=2000\n", StandardCharsets.ISO_8859_1);
      file.toFile().deleteOnExit();
      dir.toFile().deleteOnExit();
      Thread t = Thread.currentThread();
      t.setContextClassLoader(new URLClassLoader(new URL[] { dir.toUri().toURL() }, t.getContextClassLoader()));
      return resource;
    } catch (IOException e) {
      throw new IllegalStateException("cannot write OHLA settings: " + e.getMessage(), e);
    }
  }
}
