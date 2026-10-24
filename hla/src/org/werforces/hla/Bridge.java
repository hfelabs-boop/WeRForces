package org.werforces.hla;

import java.io.File;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.SocketException;
import java.net.StandardSocketOptions;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

import hla.rti1516e.AttributeHandle;
import hla.rti1516e.AttributeHandleSet;
import hla.rti1516e.AttributeHandleValueMap;
import hla.rti1516e.CallbackModel;
import hla.rti1516e.FederateHandle;
import hla.rti1516e.InteractionClassHandle;
import hla.rti1516e.NullFederateAmbassador;
import hla.rti1516e.ObjectClassHandle;
import hla.rti1516e.ObjectInstanceHandle;
import hla.rti1516e.OrderType;
import hla.rti1516e.ParameterHandle;
import hla.rti1516e.ParameterHandleValueMap;
import hla.rti1516e.RTIambassador;
import hla.rti1516e.ResignAction;
import hla.rti1516e.RtiFactory;
import hla.rti1516e.RtiFactoryFactory;
import hla.rti1516e.TransportationTypeHandle;
import hla.rti1516e.exceptions.FederatesCurrentlyJoined;
import hla.rti1516e.exceptions.FederateInternalError;
import hla.rti1516e.exceptions.FederationExecutionAlreadyExists;
import hla.rti1516e.exceptions.FederationExecutionDoesNotExist;
import hla.rti1516e.exceptions.RTIexception;

/**
 * DIS/HLA bridge federate. Entity State PDUs heard on UDP become RPR BaseEntity
 * object instances; Fire and Detonation PDUs become WeaponFire and MunitionDetonation
 * interactions. Object instances and interactions from other federates go out as DIS
 * PDUs. Only the IEEE 1516e standard API (hla.rti1516e) is used.
 *
 * Everything runs on one thread: the main loop drains the UDP queue, evokes RTI
 * callbacks (HLA_EVOKED) and runs timers, so no state needs locking.
 */
final class Bridge {
  private static final double NANOS = 1e9;

  private final Config cfg;
  private final RTIambassador rti;
  private final Queue<byte[]> datagrams = new ConcurrentLinkedQueue<>();
  /** Work queued from RTI callbacks, run after evoke returns. */
  private final Queue<Runnable> deferred = new ArrayDeque<>();
  private DatagramSocket socket;
  private InetSocketAddress disDestination;
  private volatile boolean running = true;

  // FOM handles
  private ObjectClassHandle physicalEntity;
  private final Map<String, ObjectClassHandle> classes = new HashMap<>();
  private AttributeHandle aEntityType, aEntityIdentifier, aWorldLocation, aOrientation, aVelocity, aDeadReckoning;
  private AttributeHandle aDamageState, aForce, aMarking, aImmobilized, aFirePowerDisabled, aFlames, aEngineSmoke;
  private AttributeHandleSet allAttributes;
  private List<AttributeHandle> spatial;
  private InteractionClassHandle weaponFire, munitionDetonation;
  private final Map<String, ParameterHandle> fireParams = new HashMap<>();
  private final Map<String, ParameterHandle> detParams = new HashMap<>();

  /** A DIS entity heard on UDP and registered in the federation. */
  private static final class Published {
    Dis.EntityId disId;
    ObjectInstanceHandle handle;
    String name;
    Map<AttributeHandle, byte[]> sent = new HashMap<>();
    Map<AttributeHandle, byte[]> current = new LinkedHashMap<>();
    long lastHeard;
    long lastRefresh;
    // Last DIS kinematics, to dead-reckon refreshes between Entity State PDUs.
    double[] location;
    float[] velocity;
    int deadReckoning;
  }

  /** An object instance discovered in the federation and reflected to DIS. */
  private static final class Reflected {
    ObjectInstanceHandle handle;
    String name;
    Dis.EntityId disId;
    Dis.EntityType type;
    int force;
    String marking = "";
    double[] location;
    long locationTime;
    float[] orientation = new float[3];
    float[] velocity = new float[3];
    int deadReckoning = -1;
    int damage;
    boolean immobilized, firePowerDisabled, flames, engineSmoke;
    boolean dirty;
    long lastSent;
  }

  private final Map<Dis.EntityId, Published> published = new HashMap<>();
  private final Map<ObjectInstanceHandle, Reflected> reflected = new HashMap<>();
  /** HLA object instance name to DIS entity identifier, for both directions. */
  private final Map<String, Dis.EntityId> byName = new HashMap<>();
  private final Map<Dis.EntityId, String> nameOf = new HashMap<>();
  private int nextEntityNumber = 1;

  private long pdusIn, pdusOut, updatesOut, reflectsIn, interactionsOut, interactionsIn;

  Bridge(Config cfg) throws RTIexception {
    this.cfg = cfg;
    RtiFactory factory = RtiFactoryFactory.getRtiFactory();
    log("RTI " + factory.rtiName() + " " + factory.rtiVersion());
    rti = factory.getRtiAmbassador();
    String settings = RtiSettings.designator(factory.rtiName(), cfg);
    rti.connect(new Ambassador(), CallbackModel.HLA_EVOKED, settings);
    log("connected to the RTI" + (settings.isEmpty() ? "" : " (" + settings.replace('\n', ' ') + ")"));
  }

  void run() throws Exception {
    URL fom = new File(cfg.fom).toURI().toURL();
    try {
      rti.createFederationExecution(cfg.federation, new URL[] { fom });
      log("created federation " + cfg.federation);
    } catch (FederationExecutionAlreadyExists e) {
      // another federate created it first
    }
    FederateHandle me = rti.joinFederationExecution(cfg.federateName, cfg.federateType, cfg.federation);
    resolveHandles();
    openSocket();
    log("joined federation " + cfg.federation + " as " + cfg.federateName + " (" + me + "); DIS listening on " + cfg.disBind + ":" + cfg.disPort
        + ", sending to " + cfg.disAddress + ":" + cfg.disSendPort + ", exercise " + cfg.exercise + ", reflected entities as site " + cfg.site
        + " application " + cfg.application);
    System.out.println("READY");
    System.out.flush();

    try {
      while (running) {
        byte[] d;
        while ((d = datagrams.poll()) != null) receiveDis(d);
        rti.evokeMultipleCallbacks(0.01, 0.05);
        Runnable r;
        while ((r = deferred.poll()) != null) r.run();
        tick(System.nanoTime());
      }
    } finally {
      shutdown();
    }
  }

  void stop() {
    running = false;
  }

  private void shutdown() {
    log("shutting down: " + pdusIn + " PDUs in, " + pdusOut + " out; " + updatesOut + " attribute updates, " + reflectsIn + " reflections, "
        + interactionsOut + " interactions sent, " + interactionsIn + " received");
    if (socket != null) socket.close();
    try {
      rti.resignFederationExecution(ResignAction.CANCEL_THEN_DELETE_THEN_DIVEST);
    } catch (RTIexception e) {
      warn("resign failed: " + e);
    }
    try {
      rti.destroyFederationExecution(cfg.federation);
      log("destroyed federation " + cfg.federation);
    } catch (FederatesCurrentlyJoined | FederationExecutionDoesNotExist e) {
      // others are still joined
    } catch (RTIexception e) {
      warn("destroy failed: " + e);
    }
    try {
      rti.disconnect();
    } catch (RTIexception e) {
      warn("disconnect failed: " + e);
    }
  }

  // ------------------------------------------------------------ setup

  private void resolveHandles() throws RTIexception {
    physicalEntity = rti.getObjectClassHandle("BaseEntity.PhysicalEntity");
    for (String c : new String[] { "BaseEntity.PhysicalEntity", "BaseEntity.PhysicalEntity.Platform", "BaseEntity.PhysicalEntity.Platform.Aircraft",
        "BaseEntity.PhysicalEntity.Platform.GroundVehicle", "BaseEntity.PhysicalEntity.Platform.SurfaceVessel",
        "BaseEntity.PhysicalEntity.Platform.SubmersibleVessel", "BaseEntity.PhysicalEntity.Platform.Spacecraft",
        "BaseEntity.PhysicalEntity.Lifeform", "BaseEntity.PhysicalEntity.Lifeform.Human", "BaseEntity.PhysicalEntity.Lifeform.NonHuman",
        "BaseEntity.PhysicalEntity.Munition" }) {
      classes.put(c, rti.getObjectClassHandle(c));
    }
    aEntityType = rti.getAttributeHandle(physicalEntity, "EntityType");
    aEntityIdentifier = rti.getAttributeHandle(physicalEntity, "EntityIdentifier");
    aWorldLocation = rti.getAttributeHandle(physicalEntity, "WorldLocation");
    aOrientation = rti.getAttributeHandle(physicalEntity, "Orientation");
    aVelocity = rti.getAttributeHandle(physicalEntity, "VelocityVector");
    aDeadReckoning = rti.getAttributeHandle(physicalEntity, "DeadReckoningAlgorithm");
    aDamageState = rti.getAttributeHandle(physicalEntity, "DamageState");
    aForce = rti.getAttributeHandle(physicalEntity, "ForceIdentifier");
    aMarking = rti.getAttributeHandle(physicalEntity, "Marking");
    aImmobilized = rti.getAttributeHandle(physicalEntity, "Immobilized");
    aFirePowerDisabled = rti.getAttributeHandle(physicalEntity, "FirePowerDisabled");
    aFlames = rti.getAttributeHandle(physicalEntity, "FlamesPresent");
    aEngineSmoke = rti.getAttributeHandle(physicalEntity, "EngineSmokeOn");
    spatial = List.of(aWorldLocation, aOrientation, aVelocity, aDeadReckoning);
    allAttributes = rti.getAttributeHandleSetFactory().create();
    allAttributes.addAll(List.of(aEntityType, aEntityIdentifier, aWorldLocation, aOrientation, aVelocity, aDeadReckoning, aDamageState, aForce,
        aMarking, aImmobilized, aFirePowerDisabled, aFlames, aEngineSmoke));
    for (ObjectClassHandle c : classes.values()) rti.publishObjectClassAttributes(c, allAttributes);
    rti.subscribeObjectClassAttributes(physicalEntity, allAttributes);

    weaponFire = rti.getInteractionClassHandle("WeaponFire");
    for (String p : new String[] { "EventIdentifier", "FireControlSolutionRange", "FireMissionIndex", "FiringLocation", "FiringObjectIdentifier",
        "FuseType", "InitialVelocityVector", "MunitionObjectIdentifier", "MunitionType", "QuantityFired", "RateOfFire", "TargetObjectIdentifier",
        "WarheadType" }) {
      fireParams.put(p, rti.getParameterHandle(weaponFire, p));
    }
    munitionDetonation = rti.getInteractionClassHandle("MunitionDetonation");
    for (String p : new String[] { "DetonationLocation", "DetonationResultCode", "EventIdentifier", "FiringObjectIdentifier", "FinalVelocityVector",
        "FuseType", "MunitionObjectIdentifier", "MunitionType", "QuantityFired", "RateOfFire", "RelativeDetonationLocation",
        "TargetObjectIdentifier", "WarheadType" }) {
      detParams.put(p, rti.getParameterHandle(munitionDetonation, p));
    }
    for (InteractionClassHandle ic : new InteractionClassHandle[] { weaponFire, munitionDetonation }) {
      rti.publishInteractionClass(ic);
      rti.subscribeInteractionClass(ic);
    }
  }

  private void openSocket() throws IOException {
    InetAddress dest = InetAddress.getByName(cfg.disAddress);
    disDestination = new InetSocketAddress(dest, cfg.disSendPort);
    InetSocketAddress bind = new InetSocketAddress(InetAddress.getByName(cfg.disBind), cfg.disPort);
    if (dest.isMulticastAddress()) {
      MulticastSocket ms = new MulticastSocket(null);
      ms.setReuseAddress(true);
      ms.bind(bind);
      ms.joinGroup(new InetSocketAddress(dest, 0), null);
      ms.setOption(StandardSocketOptions.IP_MULTICAST_LOOP, true);
      socket = ms;
    } else {
      socket = new DatagramSocket(null);
      socket.setReuseAddress(true);
      socket.bind(bind);
    }
    socket.setBroadcast(true);
    Thread t = new Thread(() -> {
      byte[] buf = new byte[8192];
      while (!socket.isClosed()) {
        try {
          DatagramPacket p = new DatagramPacket(buf, buf.length);
          socket.receive(p);
          datagrams.add(Arrays.copyOf(p.getData(), p.getLength()));
        } catch (SocketException e) {
          return; // closed
        } catch (IOException e) {
          warn("DIS receive: " + e);
        }
      }
    }, "dis-receiver");
    t.setDaemon(true);
    t.start();
  }

  private void sendDis(byte[] pdu) {
    try {
      socket.send(new DatagramPacket(pdu, pdu.length, disDestination));
      pdusOut++;
    } catch (IOException e) {
      warn("DIS send: " + e);
    }
  }

  // ------------------------------------------------------------ DIS -> HLA

  private boolean isOurs(Dis.EntityId id) {
    return id.site() == cfg.site && id.application() == cfg.application;
  }

  private void receiveDis(byte[] data) {
    ByteBuffer b = ByteBuffer.wrap(data);
    Dis.Header h = Dis.header(b);
    if (h == null || h.exerciseId != cfg.exercise || h.protocolVersion < 4 || h.protocolVersion > 7) return;
    try {
      switch (h.pduType) {
        case Dis.PDU_ENTITY_STATE -> receiveEntityState(Dis.decodeEntityState(b, h));
        case Dis.PDU_FIRE -> receiveFire(Dis.decodeFire(b, h));
        case Dis.PDU_DETONATION -> receiveDetonation(Dis.decodeDetonation(b, h));
        default -> {
          return;
        }
      }
    } catch (IllegalArgumentException | java.nio.BufferUnderflowException e) {
      warn("malformed PDU type " + h.pduType + ": " + e.getMessage());
    } catch (RTIexception e) {
      warn("RTI call failed for DIS PDU type " + h.pduType + ": " + e);
    }
  }

  private void receiveEntityState(Dis.EntityState pdu) throws RTIexception {
    // Our own output (entities reflected from HLA) must not go back into the federation.
    if (isOurs(pdu.entityId)) return;
    pdusIn++;
    Published p = published.get(pdu.entityId);
    if ((pdu.appearance & Dis.APPEARANCE_DEACTIVATED) != 0) {
      if (p != null) unpublish(p, "deactivated");
      return;
    }
    long now = System.nanoTime();
    if (p == null) {
      p = new Published();
      p.disId = pdu.entityId;
      String cls = classFor(pdu.entityType);
      p.handle = rti.registerObjectInstance(classes.get(cls));
      p.name = rti.getObjectInstanceName(p.handle);
      p.lastRefresh = now;
      published.put(p.disId, p);
      byName.put(p.name, p.disId);
      nameOf.put(p.disId, p.name);
      verbose("registered " + p.name + " (" + cls + ") for DIS entity " + p.disId + " '" + pdu.marking + "'");
    }
    p.lastHeard = now;
    p.location = pdu.location;
    p.velocity = pdu.velocity;
    p.deadReckoning = pdu.deadReckoning;
    int a = pdu.appearance;
    Map<AttributeHandle, byte[]> cur = p.current;
    cur.put(aEntityType, Rpr.entityType(pdu.entityType));
    cur.put(aEntityIdentifier, Rpr.entityIdentifier(pdu.entityId));
    cur.put(aWorldLocation, Rpr.worldLocation(pdu.location));
    cur.put(aOrientation, Rpr.float3(pdu.orientation));
    cur.put(aVelocity, Rpr.float3(pdu.velocity));
    cur.put(aDeadReckoning, Rpr.octet(pdu.deadReckoning));
    cur.put(aDamageState, Rpr.uint32((a & Dis.APPEARANCE_DAMAGE_MASK) >> Dis.APPEARANCE_DAMAGE_SHIFT));
    cur.put(aForce, Rpr.octet(pdu.forceId));
    cur.put(aMarking, Rpr.marking(pdu.marking));
    cur.put(aImmobilized, Rpr.octet((a & Dis.APPEARANCE_MOBILITY_KILL) != 0 ? 1 : 0));
    cur.put(aFirePowerDisabled, Rpr.octet((a & Dis.APPEARANCE_FIREPOWER_KILL) != 0 ? 1 : 0));
    cur.put(aFlames, Rpr.octet((a & Dis.APPEARANCE_FLAMING) != 0 ? 1 : 0));
    int smoke = (a & Dis.APPEARANCE_SMOKE_MASK) >> Dis.APPEARANCE_SMOKE_SHIFT;
    cur.put(aEngineSmoke, Rpr.octet(smoke >= 2 ? 1 : 0));
    update(p, null, timestampTag(pdu.timestamp));
  }

  /**
   * Sends the attributes that changed since the last update, or those in `only` (a
   * refresh or a provide request), whose WorldLocation is then dead-reckoned to now so
   * receivers do not snap back to the position of the last Entity State PDU.
   */
  private void update(Published p, AttributeHandleSet only, byte[] tag) throws RTIexception {
    if (only != null && p.deadReckoning != Dis.DR_STATIC && only.contains(aWorldLocation)) {
      double dt = (System.nanoTime() - p.lastHeard) / NANOS;
      double[] loc = p.location.clone();
      for (int i = 0; i < 3; i++) loc[i] += p.velocity[i] * dt;
      p.current.put(aWorldLocation, Rpr.worldLocation(loc));
    }
    AttributeHandleValueMap values = rti.getAttributeHandleValueMapFactory().create(p.current.size());
    boolean spatialChanged = false;
    for (Map.Entry<AttributeHandle, byte[]> e : p.current.entrySet()) {
      boolean wanted = only != null ? only.contains(e.getKey()) : !Arrays.equals(e.getValue(), p.sent.get(e.getKey()));
      if (wanted) values.put(e.getKey(), e.getValue());
      if (wanted && spatial.contains(e.getKey())) spatialChanged = true;
    }
    if (values.isEmpty()) return;
    // The spatial attributes form one dead-reckoning state (RPR 2.0 bundles them as
    // Spatial): a new velocity applies from the location sent with it.
    if (spatialChanged) for (AttributeHandle h : spatial) values.put(h, p.current.get(h));
    rti.updateAttributeValues(p.handle, values, tag);
    p.sent.putAll(values);
    updatesOut++;
  }

  private void unpublish(Published p, String why) {
    published.remove(p.disId);
    byName.remove(p.name);
    nameOf.remove(p.disId);
    try {
      rti.deleteObjectInstance(p.handle, why.getBytes(StandardCharsets.US_ASCII));
      verbose("deleted " + p.name + " (DIS entity " + p.disId + " " + why + ")");
    } catch (RTIexception e) {
      warn("delete " + p.name + ": " + e);
    }
  }

  /** RPR object class for a DIS entity type. */
  private static String classFor(Dis.EntityType t) {
    String base = "BaseEntity.PhysicalEntity";
    return switch (t.kind()) {
      case 1 -> switch (t.domain()) {
        case 1 -> base + ".Platform.GroundVehicle";
        case 2 -> base + ".Platform.Aircraft";
        case 3 -> base + ".Platform.SurfaceVessel";
        case 4 -> base + ".Platform.SubmersibleVessel";
        case 5 -> base + ".Platform.Spacecraft";
        default -> base + ".Platform";
      };
      case 2 -> base + ".Munition";
      case 3 -> base + (t.category() >= 200 ? ".Lifeform.NonHuman" : ".Lifeform.Human");
      default -> base;
    };
  }

  /** RPR user-supplied tag convention: the DIS timestamp as eight hexadecimal ASCII digits. */
  private static byte[] timestampTag(long disTimestamp) {
    return String.format("%08X", disTimestamp & 0xffffffffL).getBytes(StandardCharsets.US_ASCII);
  }

  private String objectName(Dis.EntityId id) {
    if (id == null || id.isNone()) return "";
    String n = nameOf.get(id);
    return n == null ? "" : n;
  }

  private void receiveFire(Dis.Fire pdu) throws RTIexception {
    if (isOurs(pdu.eventId) || isOurs(pdu.firing)) return;
    pdusIn++;
    String firing = objectName(pdu.firing);
    ParameterHandleValueMap v = rti.getParameterHandleValueMapFactory().create(fireParams.size());
    v.put(fireParams.get("EventIdentifier"), Rpr.eventIdentifier(pdu.eventId.entity(), firing));
    v.put(fireParams.get("FireControlSolutionRange"), Rpr.float32(pdu.range));
    v.put(fireParams.get("FireMissionIndex"), Rpr.uint32(pdu.fireMissionIndex));
    v.put(fireParams.get("FiringLocation"), Rpr.worldLocation(pdu.location));
    v.put(fireParams.get("FiringObjectIdentifier"), Rpr.objectId(firing));
    v.put(fireParams.get("FuseType"), Rpr.uint16(pdu.burst.fuse));
    v.put(fireParams.get("InitialVelocityVector"), Rpr.float3(pdu.velocity));
    v.put(fireParams.get("MunitionObjectIdentifier"), Rpr.objectId(objectName(pdu.munitionId)));
    v.put(fireParams.get("MunitionType"), Rpr.entityType(pdu.burst.munition));
    v.put(fireParams.get("QuantityFired"), Rpr.uint16(pdu.burst.quantity));
    v.put(fireParams.get("RateOfFire"), Rpr.uint16(pdu.burst.rate));
    v.put(fireParams.get("TargetObjectIdentifier"), Rpr.objectId(objectName(pdu.target)));
    v.put(fireParams.get("WarheadType"), Rpr.uint16(pdu.burst.warhead));
    rti.sendInteraction(weaponFire, v, timestampTag(pdu.timestamp));
    interactionsOut++;
    verbose("WeaponFire event " + pdu.eventId + " by " + pdu.firing + " at " + pdu.target);
  }

  private void receiveDetonation(Dis.Detonation pdu) throws RTIexception {
    if (isOurs(pdu.eventId) || isOurs(pdu.firing)) return;
    pdusIn++;
    String firing = objectName(pdu.firing);
    ParameterHandleValueMap v = rti.getParameterHandleValueMapFactory().create(detParams.size());
    v.put(detParams.get("DetonationLocation"), Rpr.worldLocation(pdu.location));
    v.put(detParams.get("DetonationResultCode"), Rpr.octet(pdu.result));
    v.put(detParams.get("EventIdentifier"), Rpr.eventIdentifier(pdu.eventId.entity(), firing));
    v.put(detParams.get("FiringObjectIdentifier"), Rpr.objectId(firing));
    v.put(detParams.get("FinalVelocityVector"), Rpr.float3(pdu.velocity));
    v.put(detParams.get("FuseType"), Rpr.uint16(pdu.burst.fuse));
    v.put(detParams.get("MunitionObjectIdentifier"), Rpr.objectId(objectName(pdu.munitionId)));
    v.put(detParams.get("MunitionType"), Rpr.entityType(pdu.burst.munition));
    v.put(detParams.get("QuantityFired"), Rpr.uint16(pdu.burst.quantity));
    v.put(detParams.get("RateOfFire"), Rpr.uint16(pdu.burst.rate));
    v.put(detParams.get("RelativeDetonationLocation"), Rpr.float3(pdu.locationInEntity));
    v.put(detParams.get("TargetObjectIdentifier"), Rpr.objectId(objectName(pdu.target)));
    v.put(detParams.get("WarheadType"), Rpr.uint16(pdu.burst.warhead));
    rti.sendInteraction(munitionDetonation, v, timestampTag(pdu.timestamp));
    interactionsOut++;
    verbose("MunitionDetonation event " + pdu.eventId + " by " + pdu.firing + " on " + pdu.target + " result " + pdu.result);
  }

  // ------------------------------------------------------------ timers

  private void tick(long now) {
    long timeout = (long) (cfg.timeout * NANOS);
    long refresh = (long) (cfg.refresh * NANOS);
    for (Published p : new ArrayList<>(published.values())) {
      if (now - p.lastHeard > timeout) {
        unpublish(p, "timed out");
      } else if (refresh > 0 && now - p.lastRefresh >= refresh) {
        p.lastRefresh = now;
        try {
          update(p, allAttributes, timestampTag(Dis.timestamp()));
        } catch (RTIexception e) {
          warn("refresh " + p.name + ": " + e);
        }
      }
    }
    long heartbeat = (long) (cfg.heartbeat * NANOS);
    for (Reflected r : reflected.values()) {
      if (r.dirty || now - r.lastSent >= heartbeat) sendEntityState(r, now, false);
    }
  }

  // ------------------------------------------------------------ HLA -> DIS

  private void discovered(ObjectInstanceHandle handle, String name) {
    if (reflected.containsKey(handle)) return;
    Reflected r = new Reflected();
    r.handle = handle;
    r.name = name;
    r.disId = new Dis.EntityId(cfg.site, cfg.application, allocateEntityNumber());
    reflected.put(handle, r);
    byName.put(name, r.disId);
    nameOf.put(r.disId, name);
    verbose("discovered " + name + " as DIS entity " + r.disId);
    // Updates are sent on change, so ask the owner for the full current state.
    deferred.add(() -> {
      try {
        rti.requestAttributeValueUpdate(handle, allAttributes, new byte[0]);
      } catch (RTIexception e) {
        warn("request update for " + name + ": " + e);
      }
    });
  }

  private int allocateEntityNumber() {
    for (int i = 0; i < 0xfffe; i++) {
      int n = nextEntityNumber;
      nextEntityNumber = nextEntityNumber % 0xfffe + 1;
      if (!nameOf.containsKey(new Dis.EntityId(cfg.site, cfg.application, n))) return n;
    }
    throw new IllegalStateException("no free DIS entity numbers");
  }

  private void reflect(ObjectInstanceHandle handle, AttributeHandleValueMap values) {
    Reflected r = reflected.get(handle);
    if (r == null) return;
    reflectsIn++;
    long now = System.nanoTime();
    try {
      for (Map.Entry<AttributeHandle, byte[]> e : values.entrySet()) {
        AttributeHandle a = e.getKey();
        byte[] v = e.getValue();
        if (a.equals(aEntityType)) r.type = Rpr.entityType(v);
        else if (a.equals(aWorldLocation)) {
          r.location = Rpr.worldLocation(v);
          r.locationTime = now;
        } else if (a.equals(aOrientation)) r.orientation = Rpr.float3(v);
        else if (a.equals(aVelocity)) {
          // Keep the dead-reckoned track continuous when only the velocity changes.
          if (r.location != null && !values.containsKey(aWorldLocation)) {
            r.location = extrapolate(r, now);
            r.locationTime = now;
          }
          r.velocity = Rpr.float3(v);
        } else if (a.equals(aDeadReckoning)) r.deadReckoning = Rpr.octet(v);
        else if (a.equals(aDamageState)) r.damage = (int) Rpr.uint32(v);
        else if (a.equals(aForce)) r.force = Rpr.octet(v);
        else if (a.equals(aMarking)) r.marking = Rpr.marking(v);
        else if (a.equals(aImmobilized)) r.immobilized = Rpr.octet(v) != 0;
        else if (a.equals(aFirePowerDisabled)) r.firePowerDisabled = Rpr.octet(v) != 0;
        else if (a.equals(aFlames)) r.flames = Rpr.octet(v) != 0;
        else if (a.equals(aEngineSmoke)) r.engineSmoke = Rpr.octet(v) != 0;
      }
    } catch (IllegalArgumentException e) {
      warn("bad attribute value for " + r.name + ": " + e.getMessage());
    }
    r.dirty = true;
  }

  private int drAlgorithm(Reflected r) {
    if (r.deadReckoning > 0) return r.deadReckoning;
    boolean moving = Math.abs(r.velocity[0]) + Math.abs(r.velocity[1]) + Math.abs(r.velocity[2]) > 0.01;
    return moving ? 2 : Dis.DR_STATIC;
  }

  private static double[] extrapolate(Reflected r, long now) {
    double dt = (now - r.locationTime) / NANOS;
    double[] p = r.location.clone();
    for (int i = 0; i < 3; i++) p[i] += r.velocity[i] * dt;
    return p;
  }

  private void sendEntityState(Reflected r, long now, boolean deactivate) {
    r.dirty = false;
    if (r.type == null || r.location == null) return; // not enough state yet
    r.lastSent = now;
    int dr = drAlgorithm(r);
    Dis.EntityState pdu = new Dis.EntityState();
    pdu.exerciseId = cfg.exercise;
    pdu.timestamp = Dis.timestamp();
    pdu.entityId = r.disId;
    pdu.forceId = r.force;
    pdu.entityType = r.type;
    pdu.velocity = deactivate ? new float[3] : r.velocity;
    // Heartbeats carry the dead-reckoned position, not the stale last reflected one.
    pdu.location = dr == Dis.DR_STATIC ? r.location : extrapolate(r, now);
    pdu.orientation = r.orientation;
    int a = (r.damage & 3) << Dis.APPEARANCE_DAMAGE_SHIFT;
    if (r.immobilized) a |= Dis.APPEARANCE_MOBILITY_KILL;
    if (r.firePowerDisabled) a |= Dis.APPEARANCE_FIREPOWER_KILL;
    if (r.flames) a |= Dis.APPEARANCE_FLAMING;
    if (r.engineSmoke) a |= 2 << Dis.APPEARANCE_SMOKE_SHIFT;
    if (deactivate) a |= Dis.APPEARANCE_DEACTIVATED;
    pdu.appearance = a;
    pdu.deadReckoning = deactivate ? Dis.DR_STATIC : dr;
    pdu.marking = r.marking;
    sendDis(Dis.encode(pdu));
  }

  private void removed(ObjectInstanceHandle handle) {
    Reflected r = reflected.remove(handle);
    if (r == null) return;
    byName.remove(r.name);
    nameOf.remove(r.disId);
    sendEntityState(r, System.nanoTime(), true);
    verbose("removed " + r.name + " (DIS entity " + r.disId + ")");
  }

  /** HLA object name to DIS entity id: ours, reflected, or none. */
  private Dis.EntityId entityFor(byte[] objectId) {
    if (objectId == null) return Dis.EntityId.NONE;
    String name = Rpr.objectId(objectId);
    Dis.EntityId id = byName.get(name);
    return id == null ? Dis.EntityId.NONE : id;
  }

  private Dis.Burst burst(Map<String, ParameterHandle> ph, ParameterHandleValueMap v) {
    Dis.Burst b = new Dis.Burst();
    byte[] m = v.get(ph.get("MunitionType"));
    b.munition = m != null ? Rpr.entityType(m) : new Dis.EntityType(new byte[8]);
    b.warhead = intOr(v.get(ph.get("WarheadType")), 0);
    b.fuse = intOr(v.get(ph.get("FuseType")), 0);
    b.quantity = intOr(v.get(ph.get("QuantityFired")), 1);
    b.rate = intOr(v.get(ph.get("RateOfFire")), 0);
    return b;
  }

  private static int intOr(byte[] v, int fallback) {
    return v == null ? fallback : Rpr.uint16(v);
  }

  private Dis.EntityId eventId(byte[] v) {
    return new Dis.EntityId(cfg.site, cfg.application, v == null ? 0 : Rpr.eventCount(v));
  }

  private void interaction(InteractionClassHandle ic, ParameterHandleValueMap v) {
    try {
      if (ic.equals(weaponFire)) {
        interactionsIn++;
        Dis.Fire pdu = new Dis.Fire();
        pdu.exerciseId = cfg.exercise;
        pdu.timestamp = Dis.timestamp();
        pdu.firing = entityFor(v.get(fireParams.get("FiringObjectIdentifier")));
        pdu.target = entityFor(v.get(fireParams.get("TargetObjectIdentifier")));
        pdu.munitionId = entityFor(v.get(fireParams.get("MunitionObjectIdentifier")));
        pdu.eventId = eventId(v.get(fireParams.get("EventIdentifier")));
        byte[] fmi = v.get(fireParams.get("FireMissionIndex"));
        pdu.fireMissionIndex = fmi == null ? 0 : Rpr.uint32(fmi);
        byte[] loc = v.get(fireParams.get("FiringLocation"));
        if (loc != null) pdu.location = Rpr.worldLocation(loc);
        pdu.burst = burst(fireParams, v);
        byte[] vel = v.get(fireParams.get("InitialVelocityVector"));
        if (vel != null) pdu.velocity = Rpr.float3(vel);
        byte[] range = v.get(fireParams.get("FireControlSolutionRange"));
        if (range != null) pdu.range = Rpr.float32(range);
        sendDis(Dis.encode(pdu));
        verbose("Fire PDU event " + pdu.eventId + " by " + pdu.firing + " at " + pdu.target);
      } else if (ic.equals(munitionDetonation)) {
        interactionsIn++;
        Dis.Detonation pdu = new Dis.Detonation();
        pdu.exerciseId = cfg.exercise;
        pdu.timestamp = Dis.timestamp();
        pdu.firing = entityFor(v.get(detParams.get("FiringObjectIdentifier")));
        pdu.target = entityFor(v.get(detParams.get("TargetObjectIdentifier")));
        pdu.munitionId = entityFor(v.get(detParams.get("MunitionObjectIdentifier")));
        pdu.eventId = eventId(v.get(detParams.get("EventIdentifier")));
        byte[] loc = v.get(detParams.get("DetonationLocation"));
        if (loc != null) pdu.location = Rpr.worldLocation(loc);
        byte[] vel = v.get(detParams.get("FinalVelocityVector"));
        if (vel != null) pdu.velocity = Rpr.float3(vel);
        byte[] rel = v.get(detParams.get("RelativeDetonationLocation"));
        if (rel != null) pdu.locationInEntity = Rpr.float3(rel);
        byte[] res = v.get(detParams.get("DetonationResultCode"));
        pdu.result = res == null ? 0 : Rpr.octet(res);
        pdu.burst = burst(detParams, v);
        sendDis(Dis.encode(pdu));
        verbose("Detonation PDU event " + pdu.eventId + " by " + pdu.firing + " on " + pdu.target + " result " + pdu.result);
      }
    } catch (IllegalArgumentException e) {
      warn("bad interaction parameters: " + e.getMessage());
    }
  }

  private void provide(ObjectInstanceHandle handle, AttributeHandleSet attributes) {
    for (Published p : published.values()) {
      if (!p.handle.equals(handle)) continue;
      try {
        update(p, attributes, timestampTag(Dis.timestamp()));
      } catch (RTIexception e) {
        warn("provide " + p.name + ": " + e);
      }
      return;
    }
  }

  private final class Ambassador extends NullFederateAmbassador {
    @Override
    public void discoverObjectInstance(ObjectInstanceHandle handle, ObjectClassHandle cls, String name) throws FederateInternalError {
      discovered(handle, name);
    }

    @Override
    public void discoverObjectInstance(ObjectInstanceHandle handle, ObjectClassHandle cls, String name, FederateHandle producer)
        throws FederateInternalError {
      discovered(handle, name);
    }

    @Override
    public void reflectAttributeValues(ObjectInstanceHandle handle, AttributeHandleValueMap values, byte[] tag, OrderType order,
        TransportationTypeHandle transport, SupplementalReflectInfo info) throws FederateInternalError {
      reflect(handle, values);
    }

    @Override
    public void removeObjectInstance(ObjectInstanceHandle handle, byte[] tag, OrderType order, SupplementalRemoveInfo info)
        throws FederateInternalError {
      removed(handle);
    }

    @Override
    public void receiveInteraction(InteractionClassHandle ic, ParameterHandleValueMap values, byte[] tag, OrderType order,
        TransportationTypeHandle transport, SupplementalReceiveInfo info) throws FederateInternalError {
      interaction(ic, values);
    }

    @Override
    public void provideAttributeValueUpdate(ObjectInstanceHandle handle, AttributeHandleSet attributes, byte[] tag) throws FederateInternalError {
      // The set may be reused by the RTI after the callback returns.
      AttributeHandleSet copy = attributes.clone();
      deferred.add(() -> provide(handle, copy));
    }
  }

  // ------------------------------------------------------------ logging

  static void log(String s) {
    System.out.println("[hla-bridge] " + s);
    System.out.flush();
  }

  static void warn(String s) {
    System.err.println("[hla-bridge] " + s);
  }

  private void verbose(String s) {
    if (cfg.verbose) log(s);
  }
}
