// Byte-for-byte check of the Dart port against the TypeScript client.
// Reference values: client/xcheck-dart.ts > test/xcheck.json (fixed test keys, no real funds).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:convert/convert.dart' show hex;
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/pda.dart';
import 'package:quantum_safe/wallet.dart';

Uint8List fill(int n, int b) => Uint8List.fromList(List.filled(n, b));

// Single-byte compact-u16 is enough for these small messages.
List<String> decodeKeys(List<int> m) {
  final n = m[3];
  return [for (var i = 0; i < n; i++) b58encode(m.sublist(4 + 32 * i, 36 + 32 * i))];
}

/// Header, signer/writable flags per key, blockhash, and each instruction with
/// its accounts resolved to addresses — independent of key order.
Map<String, Object> decode(List<int> m) {
  final keys = decodeKeys(m);
  final nSig = m[0], roSig = m[1], roUn = m[2], n = keys.length;
  String flag(int i) => '${i < nSig}/${i < nSig - roSig || (i >= nSig && i < n - roUn)}';
  var o = 4 + 32 * n;
  final bh = b58encode(m.sublist(o, o + 32));
  o += 32;
  final ixCount = m[o++];
  final ixs = <String>[];
  for (var k = 0; k < ixCount; k++) {
    final prog = keys[m[o++]];
    final na = m[o++];
    final accts = [for (var j = 0; j < na; j++) keys[m[o + j]]];
    o += na;
    var dl = m[o++];
    if (dl & 0x80 != 0) dl = (dl & 0x7f) | (m[o++] << 7);
    final data = hex.encode(m.sublist(o, o + dl));
    o += dl;
    ixs.add('$prog|${accts.join(',')}|$data');
  }
  return {
    'header': [nSig, roSig, roUn],
    'feePayer': keys[0],
    'flags': {for (var i = 0; i < n; i++) keys[i]: flag(i)},
    'blockhash': bh,
    'ixs': ixs,
  };
}

void main() {
  final ref = jsonDecode(File('test/xcheck.json').readAsStringSync()) as Map<String, dynamic>;
  final from = VaultKeys(EdKey(fill(32, 1)), fill(32, 2), fill(16, 3));
  final next = VaultKeys(EdKey(fill(32, 1)), fill(32, 4), fill(16, 5));
  final payer = EdKey(fill(32, 9));
  const recipient = '7Xu64rz6VvqzGK9TtwWh4C9DAsp3WZTec2MWNpuYosh2';
  const bh = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
  final mint = Chain.mints['devnet']!; // the reference was built by client/xcheck-dart.ts on devnet

  test('keys and addresses match', () async {
    expect(hex.encode(from.pkHash), ref['pkHash']);
    expect(await from.owner.address(), ref['owner']);
    expect(await payer.address(), ref['payer']);
    expect((await from.vault()).$1, ref['vault']);
    expect(await next.vaultTokenAccount(mint), ref['nextTa']);
  });

  // web3.js sorts accounts alphabetically inside each group; this port keeps
  // first-seen order. Both are valid, so compare the decoded meaning.
  test('transactions mean the same as the TypeScript client', () async {
    final p = await planSpend(payer, from, next, recipient, BigInt.from(123456789), bh, mint: mint);
    expect(p.digestHex, ref['digest']);
    expect(decode(p.prep.bytes), decode(base64.decode(ref['prepMsg'] as String)));
    expect(decode(p.spend.bytes), decode(base64.decode(ref['spendMsg'] as String)));
  });

  test('both signatures verify over the message', () async {
    final p = await planSpend(payer, from, next, recipient, BigInt.from(123456789), bh, mint: mint);
    final wire = base64.decode(await signTx(p.spend, [payer, from.owner]));
    expect(wire[0], 2);
    final msg = wire.sublist(1 + 64 * 2);
    expect(msg, p.spend.bytes);
    final keys = decodeKeys(msg);
    for (var i = 0; i < 2; i++) {
      final ok = await Ed25519().verify(msg,
          signature: Signature(wire.sublist(1 + 64 * i, 65 + 64 * i),
              publicKey: SimplePublicKey(b58decode(keys[i]), type: KeyPairType.ed25519)));
      expect(ok, isTrue, reason: 'signature $i');
    }
  });

  test('one-time rule refuses a second, different message', () async {
    final used = VaultKeys(EdKey(fill(32, 1)), fill(32, 2), fill(16, 3), signed: 'ff' * 24);
    expect(() => planSpend(payer, used, next, recipient, BigInt.one, bh, mint: mint), throwsStateError);
  });
}
