package org.werforces.hla;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/**
 * The DIS 7 (IEEE 1278.1) PDUs the bridge exchanges with WeRForces: Entity State, Fire
 * and Detonation. Mirrors src/dis/pdu.ts; all fields are big-endian.
 */
final class Dis {
  static final int PDU_ENTITY_STATE = 1;
  static final int PDU_FIRE = 2;
  static final int PDU_DETONATION = 3;
  static final int FAMILY_ENTITY_INFORMATION = 1;
  static final int FAMILY_WARFARE = 2;
  static final int HEADER_SIZE = 12;
  static final int ENTITY_STATE_SIZE = 144;
  static final int FIRE_SIZE = 96;
  static final int DETONATION_SIZE = 104;
  static final int PROTOCOL_VERSION = 7;

  static final int DR_STATIC = 1;

  static final int APPEARANCE_MOBILITY_KILL = 1 << 1;
  static final int APPEARANCE_FIREPOWER_KILL = 1 << 2;
  static final int APPEARANCE_DAMAGE_SHIFT = 3;
  static final int APPEARANCE_DAMAGE_MASK = 0b11 << APPEARANCE_DAMAGE_SHIFT;
  static final int APPEARANCE_SMOKE_SHIFT = 5;
  static final int APPEARANCE_SMOKE_MASK = 0b11 << APPEARANCE_SMOKE_SHIFT;
  static final int APPEARANCE_FLAMING = 1 << 15;
  static final int APPEARANCE_DEACTIVATED = 1 << 23;

  private Dis() {}

  record EntityId(int site, int application, int entity) {
    static final EntityId NONE = new EntityId(0, 0, 0);

    boolean isNone() {
      return site == 0 && application == 0 && entity == 0;
    }

    @Override
    public String toString() {
      return site + ":" + application + ":" + entity;
    }
  }

  /** The 8-octet DIS entity type, kept raw (it is byte-identical to the RPR EntityTypeStruct). */
  record EntityType(byte[] bytes) {
    int kind() {
      return bytes[0] & 0xff;
    }

    int domain() {
      return bytes[1] & 0xff;
    }

    int category() {
      return bytes[4] & 0xff;
    }
  }

  static final class Header {
    int protocolVersion;
    int exerciseId;
    int pduType;
    int protocolFamily;
    long timestamp;
  }

  static final class EntityState {
    int exerciseId;
    long timestamp;
    EntityId entityId;
    int forceId;
    EntityType entityType;
    EntityType alternateEntityType;
    float[] velocity = new float[3];
    double[] location = new double[3];
    float[] orientation = new float[3];
    int appearance;
    int deadReckoning;
    float[] acceleration = new float[3];
    float[] angularVelocity = new float[3];
    String marking = "";
    int capabilities;
  }

  static final class Burst {
    EntityType munition;
    int warhead;
    int fuse;
    int quantity;
    int rate;
  }

  static final class Fire {
    int exerciseId;
    long timestamp;
    EntityId firing;
    EntityId target;
    EntityId munitionId;
    EntityId eventId;
    long fireMissionIndex;
    double[] location = new double[3];
    Burst burst = new Burst();
    float[] velocity = new float[3];
    float range;
  }

  static final class Detonation {
    int exerciseId;
    long timestamp;
    EntityId firing;
    EntityId target;
    EntityId munitionId;
    EntityId eventId;
    float[] velocity = new float[3];
    double[] location = new double[3];
    Burst burst = new Burst();
    float[] locationInEntity = new float[3];
    int result;
  }

  /** DIS relative timestamp: units of 3600/2^31 s past the hour, low bit 0. */
  static long timestamp() {
    Instant now = Instant.now();
    double secondsPastHour = (now.getEpochSecond() % 3600) + now.getNano() / 1e9;
    long units = (long) Math.floor(secondsPastHour / 3600 * 0x7fffffffL);
    return (units << 1) & 0xffffffffL;
  }

  // ------------------------------------------------------------ decoding

  static Header header(ByteBuffer b) {
    if (b.remaining() < HEADER_SIZE) return null;
    Header h = new Header();
    h.protocolVersion = u8(b);
    h.exerciseId = u8(b);
    h.pduType = u8(b);
    h.protocolFamily = u8(b);
    h.timestamp = u32(b);
    b.position(b.position() + 4); // length, status, padding
    return h;
  }

  static EntityState decodeEntityState(ByteBuffer b, Header h) {
    if (b.limit() < ENTITY_STATE_SIZE) throw new IllegalArgumentException("Entity State PDU too short");
    EntityState p = new EntityState();
    p.exerciseId = h.exerciseId;
    p.timestamp = h.timestamp;
    p.entityId = id(b);
    p.forceId = u8(b);
    u8(b); // variable parameter count; the records are ignored
    p.entityType = type(b);
    p.alternateEntityType = type(b);
    get3(b, p.velocity);
    get3(b, p.location);
    get3(b, p.orientation);
    p.appearance = b.getInt();
    p.deadReckoning = u8(b);
    b.position(b.position() + 15);
    get3(b, p.acceleration);
    get3(b, p.angularVelocity);
    u8(b); // marking character set
    byte[] chars = new byte[11];
    b.get(chars);
    p.marking = marking(chars);
    p.capabilities = b.getInt();
    return p;
  }

  static Fire decodeFire(ByteBuffer b, Header h) {
    if (b.limit() < FIRE_SIZE) throw new IllegalArgumentException("Fire PDU too short");
    Fire p = new Fire();
    p.exerciseId = h.exerciseId;
    p.timestamp = h.timestamp;
    p.firing = id(b);
    p.target = id(b);
    p.munitionId = id(b);
    p.eventId = id(b);
    p.fireMissionIndex = u32(b);
    get3(b, p.location);
    p.burst = burst(b);
    get3(b, p.velocity);
    p.range = b.getFloat();
    return p;
  }

  static Detonation decodeDetonation(ByteBuffer b, Header h) {
    if (b.limit() < DETONATION_SIZE) throw new IllegalArgumentException("Detonation PDU too short");
    Detonation p = new Detonation();
    p.exerciseId = h.exerciseId;
    p.timestamp = h.timestamp;
    p.firing = id(b);
    p.target = id(b);
    p.munitionId = id(b);
    p.eventId = id(b);
    get3(b, p.velocity);
    get3(b, p.location);
    p.burst = burst(b);
    get3(b, p.locationInEntity);
    p.result = u8(b);
    return p;
  }

  // ------------------------------------------------------------ encoding

  static byte[] encode(EntityState p) {
    ByteBuffer b = ByteBuffer.allocate(ENTITY_STATE_SIZE);
    header(b, p.exerciseId, PDU_ENTITY_STATE, FAMILY_ENTITY_INFORMATION, p.timestamp, ENTITY_STATE_SIZE);
    id(b, p.entityId);
    b.put((byte) p.forceId);
    b.put((byte) 0);
    b.put(p.entityType.bytes());
    b.put((p.alternateEntityType != null ? p.alternateEntityType : p.entityType).bytes());
    put3(b, p.velocity);
    put3(b, p.location);
    put3(b, p.orientation);
    b.putInt(p.appearance);
    b.put((byte) p.deadReckoning);
    b.position(b.position() + 15);
    put3(b, p.acceleration);
    put3(b, p.angularVelocity);
    b.put((byte) 1); // ASCII
    b.put(markingBytes(p.marking));
    b.putInt(p.capabilities);
    return b.array();
  }

  static byte[] encode(Fire p) {
    ByteBuffer b = ByteBuffer.allocate(FIRE_SIZE);
    header(b, p.exerciseId, PDU_FIRE, FAMILY_WARFARE, p.timestamp, FIRE_SIZE);
    id(b, p.firing);
    id(b, p.target);
    id(b, p.munitionId);
    id(b, p.eventId);
    b.putInt((int) p.fireMissionIndex);
    put3(b, p.location);
    burst(b, p.burst);
    put3(b, p.velocity);
    b.putFloat(p.range);
    return b.array();
  }

  static byte[] encode(Detonation p) {
    ByteBuffer b = ByteBuffer.allocate(DETONATION_SIZE);
    header(b, p.exerciseId, PDU_DETONATION, FAMILY_WARFARE, p.timestamp, DETONATION_SIZE);
    id(b, p.firing);
    id(b, p.target);
    id(b, p.munitionId);
    id(b, p.eventId);
    put3(b, p.velocity);
    put3(b, p.location);
    burst(b, p.burst);
    put3(b, p.locationInEntity);
    b.put((byte) p.result);
    b.put((byte) 0); // variable parameter count
    b.putShort((short) 0);
    return b.array();
  }

  // ------------------------------------------------------------ helpers

  static String marking(byte[] chars) {
    int n = 0;
    while (n < chars.length && chars[n] != 0) n++;
    return new String(chars, 0, n, StandardCharsets.US_ASCII);
  }

  /** 11 NUL-padded ASCII characters; non-ASCII becomes '?'. */
  static byte[] markingBytes(String s) {
    byte[] out = new byte[11];
    for (int i = 0; i < 11 && i < s.length(); i++) {
      char c = s.charAt(i);
      out[i] = (byte) (c < 128 ? c : '?');
    }
    return out;
  }

  private static void header(ByteBuffer b, int exercise, int type, int family, long timestamp, int length) {
    b.put((byte) PROTOCOL_VERSION);
    b.put((byte) exercise);
    b.put((byte) type);
    b.put((byte) family);
    b.putInt((int) timestamp);
    b.putShort((short) length);
    b.putShort((short) 0); // PDU status, padding
  }

  private static int u8(ByteBuffer b) {
    return b.get() & 0xff;
  }

  private static int u16(ByteBuffer b) {
    return b.getShort() & 0xffff;
  }

  private static long u32(ByteBuffer b) {
    return b.getInt() & 0xffffffffL;
  }

  private static EntityId id(ByteBuffer b) {
    return new EntityId(u16(b), u16(b), u16(b));
  }

  private static void id(ByteBuffer b, EntityId id) {
    b.putShort((short) id.site());
    b.putShort((short) id.application());
    b.putShort((short) id.entity());
  }

  private static EntityType type(ByteBuffer b) {
    byte[] t = new byte[8];
    b.get(t);
    return new EntityType(t);
  }

  private static Burst burst(ByteBuffer b) {
    Burst x = new Burst();
    x.munition = type(b);
    x.warhead = u16(b);
    x.fuse = u16(b);
    x.quantity = u16(b);
    x.rate = u16(b);
    return x;
  }

  private static void burst(ByteBuffer b, Burst x) {
    b.put(x.munition.bytes());
    b.putShort((short) x.warhead);
    b.putShort((short) x.fuse);
    b.putShort((short) x.quantity);
    b.putShort((short) x.rate);
  }

  private static void get3(ByteBuffer b, float[] v) {
    for (int i = 0; i < 3; i++) v[i] = b.getFloat();
  }

  private static void get3(ByteBuffer b, double[] v) {
    for (int i = 0; i < 3; i++) v[i] = b.getDouble();
  }

  private static void put3(ByteBuffer b, float[] v) {
    for (int i = 0; i < 3; i++) b.putFloat(v[i]);
  }

  private static void put3(ByteBuffer b, double[] v) {
    for (int i = 0; i < 3; i++) b.putDouble(v[i]);
  }
}
