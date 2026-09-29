@Tags(['network'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';

// Hits the real devnet RPC. Run with: flutter test test/chain_live_test.dart
void main() {
  // alloc-founder token account from client/allocations-devnet.json.
  test('reads a real QC token account from devnet', () async {
    final ch = Chain('devnet', rpc: Platform.environment['QC_RPC']);
    const acct = '3vYAe7m93Cd9F6SN4LyJsBQyXQSyftHqPoXJxSXZ3tBK';
    expect(await ch.tokenAccounts(acct), [acct]);
    final bal = await ch.balance([acct]);
    final hist = await ch.history([acct], limit: 5);
    // ignore: avoid_print
    print('balance=${fmtUnits(bal)} QC txs=${hist.length} first=${hist.first.signature}');
    expect(bal, BigInt.parse('220000000000000000'));
    expect(hist, isNotEmpty);
  }, timeout: const Timeout(Duration(minutes: 3)));
}
