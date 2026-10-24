package org.werforces.hla;

/** SIGINT/SIGTERM handling, falling back to a shutdown hook where sun.misc.Signal is missing. */
final class Signals {
  private Signals() {}

  /** Runs `stop` on a signal, then exits; as a shutdown hook it only runs `stop`. */
  static void install(Runnable stop) {
    try {
      sun.misc.SignalHandler h = sig -> new Thread(() -> {
        stop.run();
        System.exit(0);
      }, "bridge-stop").start();
      sun.misc.Signal.handle(new sun.misc.Signal("INT"), h);
      sun.misc.Signal.handle(new sun.misc.Signal("TERM"), h);
    } catch (Throwable t) {
      Runtime.getRuntime().addShutdownHook(new Thread(stop, "bridge-stop"));
    }
  }
}
