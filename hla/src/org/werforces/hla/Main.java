package org.werforces.hla;

/** Entry point of the WeRForces DIS/HLA bridge federate. */
public final class Main {
  private Main() {}

  public static void main(String[] args) {
    Config cfg;
    try {
      cfg = Config.parse(args);
    } catch (IllegalArgumentException e) {
      System.err.println(e.getMessage());
      System.exit(2);
      return;
    }
    Bridge bridge;
    try {
      bridge = new Bridge(cfg);
    } catch (Exception e) {
      Bridge.warn("cannot connect to the RTI: " + e);
      if (e.getCause() != null) Bridge.warn("  caused by " + e.getCause());
      System.exit(1);
      return;
    }
    Thread main = Thread.currentThread();
    // Resign cleanly (deleting our object instances) on Ctrl-C or kill, before the
    // JVM shutdown hooks run; some RTIs resign without deleting objects in theirs.
    Signals.install(() -> {
      bridge.stop();
      try {
        main.join(5000);
      } catch (InterruptedException ignored) {
        // exit anyway
      }
    });
    try {
      bridge.run();
    } catch (Exception e) {
      Bridge.warn("bridge failed: " + e);
      e.printStackTrace();
      System.exit(1);
    }
  }
}
