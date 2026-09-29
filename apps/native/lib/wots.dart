// Winternitz one-time signatures. Mirror of client/qc.ts and programs/qc-vault/src/wots.rs.
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const wotsN = 24, msgDigits = 24, chains = 26, seedLen = 16;
final _dChain = ascii.encode('QCV1/chain'), _dPk = ascii.encode('QCV1/pk'),
    _dMsg = ascii.encode('QCV1/msg'), _dSk = ascii.encode('QCV1/sk');

Uint8List _sha(List<List<int>> parts) {
  final b = BytesBuilder(copy: false);
  for (final p in parts) {
    b.add(p);
  }
  return Uint8List.fromList(sha256.convert(b.takeBytes()).bytes);
}

Uint8List _chain(List<int> seed, int i, int from, int to, Uint8List x) {
  var v = x;
  for (var s = from; s < to; s++) {
    v = _sha([_dChain, seed, [i, s], v]).sublist(0, wotsN);
  }
  return v;
}

List<int> digits(List<int> digest) {
  final d = digest.sublist(0, msgDigits);
  final csum = d.fold<int>(0, (a, x) => a + (255 - x));
  return [...d, csum >> 8, csum & 0xff];
}

Uint8List _secretChain(List<int> master, int i) => _sha([_dSk, master, [i]]).sublist(0, wotsN);

Uint8List publicKeyHash(List<int> master, List<int> seed) {
  final ends = BytesBuilder(copy: false);
  for (var i = 0; i < chains; i++) {
    ends.add(_chain(seed, i, 0, 255, _secretChain(master, i)));
  }
  return _sha([_dPk, seed, ends.takeBytes()]);
}

Uint8List wotsSign(List<int> master, List<int> seed, List<int> digest) {
  final d = digits(digest);
  final out = BytesBuilder(copy: false);
  for (var i = 0; i < chains; i++) {
    out.add(_chain(seed, i, 0, d[i], _secretChain(master, i)));
  }
  return out.takeBytes();
}

Uint8List _u64(BigInt v) {
  final b = ByteData(8)..setUint64(0, v.toInt(), Endian.little);
  return b.buffer.asUint8List();
}

Uint8List u64le(BigInt v) => _u64(v);

Uint8List spendDigest(List<int> program, List<int> vault, List<int> mint, List<int> dest,
        List<int> refund, List<int> rentTo, BigInt amount) =>
    _sha([_dMsg, program, vault, mint, dest, refund, rentTo, _u64(amount)]).sublist(0, msgDigits);
