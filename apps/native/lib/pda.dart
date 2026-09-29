import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const _alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

Uint8List b58decode(String s) {
  var n = BigInt.zero;
  for (final ch in s.split('')) {
    final i = _alphabet.indexOf(ch);
    if (i < 0) throw FormatException('bad base58 char $ch');
    n = n * BigInt.from(58) + BigInt.from(i);
  }
  final bytes = <int>[];
  while (n > BigInt.zero) {
    bytes.insert(0, (n & BigInt.from(255)).toInt());
    n = n >> 8;
  }
  final zeros = s.split('').takeWhile((c) => c == '1').length;
  return Uint8List.fromList(List.filled(zeros, 0) + bytes);
}

String b58encode(List<int> b) {
  var n = BigInt.zero;
  for (final x in b) {
    n = (n << 8) | BigInt.from(x);
  }
  final out = StringBuffer();
  final chars = <String>[];
  while (n > BigInt.zero) {
    chars.insert(0, _alphabet[(n % BigInt.from(58)).toInt()]);
    n = n ~/ BigInt.from(58);
  }
  for (final x in b) {
    if (x != 0) break;
    out.write('1');
  }
  out.writeAll(chars);
  return out.toString();
}

// ed25519: p = 2^255 - 19, d = -121665/121666.
final _p = (BigInt.one << 255) - BigInt.from(19);
final _d = (BigInt.from(-121665) * BigInt.from(121666).modPow(_p - BigInt.two, _p)) % _p;

/// True when the 32 bytes decompress to a point on the ed25519 curve.
bool isOnCurve(List<int> key) {
  final b = List<int>.from(key);
  b[31] &= 0x7f;
  var y = BigInt.zero;
  for (var i = 31; i >= 0; i--) {
    y = (y << 8) | BigInt.from(b[i]);
  }
  if (y >= _p) return false;
  final y2 = (y * y) % _p;
  final u = (y2 - BigInt.one) % _p;
  final v = (_d * y2 + BigInt.one) % _p;
  final x2 = (u * v.modPow(_p - BigInt.two, _p)) % _p;
  if (x2 == BigInt.zero) return true;
  // x2 must be a quadratic residue.
  return x2.modPow((_p - BigInt.one) >> 1, _p) == BigInt.one;
}

(String, int) findProgramAddressWithBump(List<List<int>> seeds, String programId) {
  final prog = b58decode(programId);
  for (var bump = 255; bump >= 0; bump--) {
    final h = sha256.convert([
      for (final s in seeds) ...s,
      bump,
      ...prog,
      ...utf8.encode('ProgramDerivedAddress'),
    ]).bytes;
    if (!isOnCurve(h)) return (b58encode(h), bump);
  }
  throw StateError('no PDA');
}

String findProgramAddress(List<List<int>> seeds, String programId) => findProgramAddressWithBump(seeds, programId).$1;

const token2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ataProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

String associatedTokenAddress(String owner, String mint) =>
    findProgramAddress([b58decode(owner), b58decode(token2022), b58decode(mint)], ataProgram);
