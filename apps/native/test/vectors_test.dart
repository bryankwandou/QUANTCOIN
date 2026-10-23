// The Dart port must reproduce audit/test-vectors.txt (client/vectors.ts) byte for
// byte; programs/qc-vault/tests/vectors.rs checks the on-chain code against the same file.
import 'dart:io';
import 'dart:typed_data';

import 'package:convert/convert.dart' show hex;
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/pda.dart';
import 'package:quantum_safe/wallet.dart';
import 'package:quantum_safe/wots.dart';

Uint8List h(String s) => Uint8List.fromList(hex.decode(s));

void main() {
  final lines = File('../../audit/test-vectors.txt')
      .readAsLinesSync()
      .where((l) => l.isNotEmpty && !l.startsWith('#'))
      .map((l) => l.split(' '))
      .toList();

  test('vector file is complete', () {
    final count = <String, int>{};
    for (final f in lines) {
      count[f[0]] = (count[f[0]] ?? 0) + 1;
    }
    expect(count, {'pk': 3, 'sig': 9, 'digest': 4, 'pda': 3, 'ata': 3});
  });

  test('WOTS public key, checksum digits and signatures', () {
    for (final f in lines.where((f) => f[0] == 'pk')) {
      expect(hex.encode(publicKeyHash(h(f[1]), h(f[2]))), f[3]);
    }
    for (final f in lines.where((f) => f[0] == 'sig')) {
      final d = digits(h(f[3]));
      expect([d[24], d[25]], [int.parse(f[4]), int.parse(f[5])]);
      expect(hex.encode(wotsSign(h(f[1]), h(f[2]), h(f[3]))), f[6]);
    }
  });

  test('spend digest, including amount 2^64-1', () {
    for (final f in lines.where((f) => f[0] == 'digest')) {
      expect(f[1], hex.encode(pubkey(qcProgram)));
      expect(hex.encode(spendDigest(h(f[1]), h(f[2]), h(f[3]), h(f[4]), h(f[5]), h(f[6]), BigInt.parse(f[7]))), f[8]);
    }
  });

  test('vault PDA, bump and vault token account', () async {
    for (final f in lines.where((f) => f[0] == 'pda')) {
      final v = VaultKeys(EdKey(h(f[3])), h(f[1]), h(f[2]));
      expect(hex.encode(pubkey(await v.owner.address())), f[4]);
      final (pda, bump) = await v.vault();
      expect([hex.encode(pubkey(pda)), bump], [f[5], int.parse(f[6])]);
    }
    for (final f in lines.where((f) => f[0] == 'ata')) {
      expect(hex.encode(pubkey(associatedTokenAddress(b58encode(h(f[1])), b58encode(h(f[2]))))), f[3]);
    }
  });

  test('amounts outside u64 are refused, not clamped', () {
    expect(hex.encode(u64le((BigInt.one << 64) - BigInt.one)), 'ff' * 8);
    expect(() => u64le(BigInt.one << 64), throwsRangeError);
    expect(() => u64le(BigInt.from(-1)), throwsRangeError);
  });

  test('a non-canonical y (>= p) is judged like Solana does: reduced mod p', () {
    // p + 1 reduces to y = 1, the identity point, which is on the curve.
    final b = List<int>.filled(32, 0xff)..[0] = 0xee..[31] = 0x7f;
    expect(isOnCurve(b), isTrue);
  });
}
