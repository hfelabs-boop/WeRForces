package org.werforces.hla;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * Encoders and decoders for the RPR FOM 2.0 datatypes in hla/fom/werforces-rpr.xml,
 * using the IEEE 1516.2-2010 encoding rules: big-endian basic types, fixed records
 * with each field aligned to its own octet boundary; RTIobjectId uses the RPR FOM 2.0
 * RPRnullTerminatedArray encoding (ASCII characters followed by NUL).
 */
final class Rpr {
  private Rpr() {}

  // Several RPR records are byte-for-byte the DIS fields: EntityTypeStruct (8 octets),
  // EntityIdentifierStruct (6), WorldLocationStruct (24), OrientationStruct and
  // VelocityVectorStruct (12), MarkingStruct (12).

  static byte[] entityType(Dis.EntityType t) {
    return t.bytes().clone();
  }

  static Dis.EntityType entityType(byte[] b) {
    need(b, 8);
    byte[] t = new byte[8];
    System.arraycopy(b, 0, t, 0, 8);
    return new Dis.EntityType(t);
  }

  static byte[] entityIdentifier(Dis.EntityId id) {
    return ByteBuffer.allocate(6).putShort((short) id.site()).putShort((short) id.application()).putShort((short) id.entity()).array();
  }

  static Dis.EntityId entityIdentifier(byte[] b) {
    need(b, 6);
    ByteBuffer x = ByteBuffer.wrap(b);
    return new Dis.EntityId(x.getShort() & 0xffff, x.getShort() & 0xffff, x.getShort() & 0xffff);
  }

  static byte[] worldLocation(double[] v) {
    ByteBuffer b = ByteBuffer.allocate(24);
    for (double d : v) b.putDouble(d);
    return b.array();
  }

  static double[] worldLocation(byte[] b) {
    need(b, 24);
    ByteBuffer x = ByteBuffer.wrap(b);
    return new double[] { x.getDouble(), x.getDouble(), x.getDouble() };
  }

  /** OrientationStruct, VelocityVectorStruct and RelativePositionStruct: three HLAfloat32BE. */
  static byte[] float3(float[] v) {
    ByteBuffer b = ByteBuffer.allocate(12);
    for (float f : v) b.putFloat(f);
    return b.array();
  }

  static float[] float3(byte[] b) {
    need(b, 12);
    ByteBuffer x = ByteBuffer.wrap(b);
    return new float[] { x.getFloat(), x.getFloat(), x.getFloat() };
  }

  /** HLAoctet-based enumerations (ForceIdentifierEnum8, RPRboolean, ...). */
  static byte[] octet(int v) {
    return new byte[] { (byte) v };
  }

  static int octet(byte[] b) {
    need(b, 1);
    return b[0] & 0xff;
  }

  /** HLAinteger16BE / RPRunsignedInteger16BE. */
  static byte[] uint16(int v) {
    return ByteBuffer.allocate(2).putShort((short) v).array();
  }

  static int uint16(byte[] b) {
    need(b, 2);
    return ByteBuffer.wrap(b).getShort() & 0xffff;
  }

  /** HLAinteger32BE / RPRunsignedInteger32BE (DamageStatusEnum32, FireMissionIndex). */
  static byte[] uint32(long v) {
    return ByteBuffer.allocate(4).putInt((int) v).array();
  }

  static long uint32(byte[] b) {
    need(b, 4);
    return ByteBuffer.wrap(b).getInt() & 0xffffffffL;
  }

  static byte[] float32(float v) {
    return ByteBuffer.allocate(4).putFloat(v).array();
  }

  static float float32(byte[] b) {
    need(b, 4);
    return ByteBuffer.wrap(b).getFloat();
  }

  /** MarkingStruct: MarkingEncodingEnum8 (1 = ASCII) then 11 NUL-padded characters. */
  static byte[] marking(String s) {
    ByteBuffer b = ByteBuffer.allocate(12);
    b.put((byte) 1);
    b.put(Dis.markingBytes(s));
    return b.array();
  }

  static String marking(byte[] b) {
    need(b, 12);
    byte[] chars = new byte[11];
    System.arraycopy(b, 1, chars, 0, 11);
    return Dis.marking(chars);
  }

  /** RTIobjectId: the ASCII characters of an object instance name, then NUL (RPRnullTerminatedArray). */
  static byte[] objectId(String name) {
    byte[] chars = name.getBytes(StandardCharsets.US_ASCII);
    return ByteBuffer.allocate(chars.length + 1).put(chars).put((byte) 0).array();
  }

  static String objectId(byte[] b) {
    return readObjectId(b, 0);
  }

  /** EventIdentifierStruct: EventCount (UnsignedInteger16), then IssuingObjectIdentifier (RTIobjectId). */
  static byte[] eventIdentifier(int count, String issuer) {
    byte[] id = objectId(issuer);
    return ByteBuffer.allocate(2 + id.length).putShort((short) count).put(id).array();
  }

  static int eventCount(byte[] b) {
    need(b, 2);
    return ByteBuffer.wrap(b).getShort() & 0xffff;
  }

  /** Reads up to the NUL; a missing terminator ends the string at the end of the buffer. */
  private static String readObjectId(byte[] b, int from) {
    if (b == null) return "";
    int end = from;
    while (end < b.length && b[end] != 0) end++;
    return new String(b, from, end - from, StandardCharsets.US_ASCII);
  }

  private static void need(byte[] b, int n) {
    if (b == null || b.length < n) throw new IllegalArgumentException("expected " + n + " octets, got " + (b == null ? 0 : b.length));
  }
}
