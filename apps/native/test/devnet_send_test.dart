@Tags(['devnet-send'])
library;

// Real sends on devnet signed by the Dart port. Moves devnet QC only.
// Run: QC_RPC=<rpc> flutter test test/devnet_send_test.dart
// Every new key is written to client/keys/ (CLI format) BEFORE broadcasting.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:convert/convert.dart' show hex;
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/pda.dart';
import 'package:quantum_safe/send.dart';
import 'package:quantum_safe/wallet.dart';
import 'package:quantum_safe/tx.dart';

const keys = '../../client/keys';

Future<void> saveCli(String name, VaultKeys v) async {
  final pub = b58decode(await v.owner.address());
  final f = File('$keys/vault-$name.json');
  await f.writeAsString(const JsonEncoder.withIndent(' ').convert({
    'owner': [...v.owner.seed, ...pub],
    'master': hex.encode(v.master),
    'seed': hex.encode(v.seed),
    'used': v.signed != null,
    if (v.signed != null) 'signed': v.signed,
  }), flush: true);
}

void main() {
  test('treasury-9 -> app vault -> fee wallet, all signed in Dart', () async {
    final chain = Chain('devnet', rpc: Platform.environment['QC_RPC']);
    final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME']!;
    final payerSecret = (jsonDecode(File('$home/.config/solana/bersih-devnet.json').readAsStringSync()) as List).cast<int>();
    final payer = EdKey(Uint8List.fromList(payerSecret.sublist(0, 32)));
    final fee = await payer.address();
    expect(fee, 'AUo5JFnRhLtD6PJaWDj98M2ZmHWbLPcrKiR2QPY95AG7');

    for (final n in ['treasury-10', 'app-test-3', 'app-test-4']) {
      expect(File('$keys/vault-$n.json').existsSync(), isFalse, reason: '$n exists; refusing to overwrite keys');
    }

    // 1. treasury-8 sends 1 QC to a vault created by the app code.
    final t8 = VaultKeys.fromCli(File('$keys/vault-treasury-9.json').readAsStringSync());
    expect(t8.signed, isNull);
    final t9 = VaultKeys.fresh(t8.owner);
    final app1 = VaultKeys.fresh(EdKey.fresh());
    await saveCli('app-test-3', app1);
    final app1Vault = (await app1.vault()).$1;
    final t8Before = await chain.balance([await t8.vaultTokenAccount()]);

    final s1 = await sendQc(
      chain: chain, payer: payer, from: t8, next: t9, recipient: app1Vault, amount: BigInt.from(100000),
      persist: () async { await saveCli('treasury-10', t9); await saveCli('treasury-9', t8); },
    );
    // ignore: avoid_print
    print('spend 1: $s1');
    expect(await chain.balance([await app1.vaultTokenAccount()]), BigInt.from(100000));
    expect(await chain.balance([await t9.vaultTokenAccount()]), t8Before - BigInt.from(100000));

    // 2. The app vault sends 0.5 QC to the fee wallet; the rest rotates to app-test-2.
    final app2 = VaultKeys.fresh(app1.owner);
    final s2 = await sendQc(
      chain: chain, payer: payer, from: app1, next: app2, recipient: fee, amount: BigInt.from(50000),
      persist: () async { await saveCli('app-test-4', app2); await saveCli('app-test-3', app1); },
    );
    // ignore: avoid_print
    print('spend 2: $s2');
    expect(await chain.balance([await app2.vaultTokenAccount()]), BigInt.from(50000));
    expect(await chain.balance([associatedTokenAddress(fee, Chain.mint)]), greaterThanOrEqualTo(BigInt.from(50000)));

    // 3. Both spent vaults are now marked on chain (owned by the program).
    for (final v in [t8, app1]) {
      expect(await chain.accountOwner((await v.vault()).$1), qcProgram);
    }
    // 4. Replay of the spent app-test-3 key (same digest, re-created ATA) is refused.
    final bh = await chain.latestBlockhash();
    final replay = await planSpend(payer, app1, app2, fee, BigInt.from(50000), bh);
    await chain.send(await signTx(replay.prep, [payer]));
    await expectLater(chain.send(await signTx(replay.spend, [payer, app1.owner])), throwsA(predicate((e) => e is ChainError && e.message.contains('0x8'), 'AlreadySpent (0x8)')));
  }, timeout: const Timeout(Duration(minutes: 5)));
}
