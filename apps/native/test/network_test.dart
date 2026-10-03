// Each network must use the mint its genesis actually created. The app once
// shipped the devnet mint for mainnet too: balances read 0 and a send signed
// a one-time key over a digest for the wrong mint.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';

void main() {
  for (final net in ['devnet', 'mainnet']) {
    test('$net uses the mint from its genesis record', () {
      final file = File(net == 'devnet' ? '../../client/genesis.json' : '../../client/genesis-$net.json');
      final genesis = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      expect(Chain(net).mint, genesis['mint']);
    });
  }

  test('networks do not share a mint', () {
    expect(Chain.mints.values.toSet().length, Chain.mints.length);
    expect(Chain.mints.keys.toSet(), Chain.networks.keys.toSet());
  });
}
