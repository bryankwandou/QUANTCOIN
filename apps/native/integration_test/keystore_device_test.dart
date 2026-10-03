// Runs inside the real app on a device, simulator or desktop (not the Dart VM), so the
// platform keychain is the real one: flutter test integration_test -d <device>
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:quantum_safe/keystore.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('vault keys survive a write and read through the platform keychain', (tester) async {
    final store = KeyStore('itest-${DateTime.now().millisecondsSinceEpoch}');
    expect(await store.load(), isNull);
    final made = await store.create();
    final read = await store.load();
    expect(read, isNotNull);
    expect(jsonEncode(read!.toJson()), jsonEncode(made.toJson()));
    expect(await read.payer.address(), await made.payer.address());
    await store.clear();
    expect(await store.load(), isNull);
  });
}
