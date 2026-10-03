@Tags(['devnet-send'])
library;

// UI end-to-end on devnet: the real widget tree is driven by taps and typing
// (passcode, import vault file, recipient, amount, confirm) and the send it
// produces is checked on chain. Only the OS fingerprint prompt is stubbed.
// Run: QC_RPC=<rpc> QC_FROM=<funded treasury vault name> flutter test test/ui_send_e2e_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:convert/convert.dart' show hex;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/keystore.dart';
import 'package:quantum_safe/main.dart';
import 'package:quantum_safe/pda.dart';
import 'package:quantum_safe/send.dart';
import 'package:quantum_safe/tx.dart';
import 'package:quantum_safe/wallet.dart';
import 'package:shared_preferences/shared_preferences.dart';

const keys = '../../client/keys';

String cliJson(VaultKeys v, String pub) => const JsonEncoder.withIndent(' ').convert({
      'owner': [...v.owner.seed, ...b58decode(pub)],
      'master': hex.encode(v.master),
      'seed': hex.encode(v.seed),
      'used': v.signed != null,
      if (v.signed != null) 'signed': v.signed,
    });

Future<void> saveCli(String name, VaultKeys v) async =>
    File('$keys/vault-$name.json').writeAsString(cliJson(v, await v.owner.address()), flush: true);

void main() {
  testWidgets('send through the UI lands on devnet', (tester) async {
    HttpOverrides.global = null; // real network; flutter_test blocks HTTP by default
    // google_fonts caches downloads via path_provider, which has no plugin in tests.
    final tmp = Directory.systemTemp.createTempSync('qc-ui').path;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'), (_) async => tmp);
    final env = Platform.environment;
    final rpc = env['QC_RPC']!;
    final fromName = env['QC_FROM'] ?? 'treasury-11';
    final chain = Chain('devnet', rpc: rpc);
    final home = env['USERPROFILE'] ?? env['HOME']!;
    final payer = EdKey(Uint8List.fromList(
        (jsonDecode(File('$home/.config/solana/bersih-devnet.json').readAsStringSync()) as List).cast<int>().sublist(0, 32)));
    final fee = await payer.address();
    final stamp = DateTime.now().millisecondsSinceEpoch;
    final uiName = 'ui-test-$stamp';

    // ── 0. Fund a small vault for the UI from the treasury (Dart signer, keys saved first).
    late VaultKeys ui;
    await tester.runAsync(() async {
      final from = VaultKeys.fromCli(File('$keys/vault-$fromName.json').readAsStringSync());
      expect(from.signed, isNull, reason: '$fromName already used');
      final next = VaultKeys.fresh(from.owner);
      ui = VaultKeys.fresh(EdKey.fresh());
      await saveCli(uiName, ui);
      await sendQc(chain: chain, payer: payer, from: from, next: next, recipient: (await ui.vault()).$1,
          amount: BigInt.from(200000), // 2 QC
          persist: () async { await saveCli('treasury-next-$stamp', next); await saveCli(fromName, from); });
    });

    // ── 1. Fresh install.
    SharedPreferences.setMockInitialValues({'rpc': rpc, 'network': 'devnet'});
    FlutterSecureStorage.setMockInitialValues({});
    var authAsked = 0;
    deviceAuth = (_) async { authAsked++; return true; };
    final prefs = await SharedPreferences.getInstance();
    tester.view.physicalSize = const Size(1236, 2745); // phone, 412 x 915 dp
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(QuantumSafe(prefs: prefs));
    await tester.pumpAndSettle();

    Future<void> waitFor(Finder f, {int seconds = 120}) async {
      final end = DateTime.now().add(Duration(seconds: seconds));
      while (f.evaluate().isEmpty) {
        if (DateTime.now().isAfter(end)) {
          final shown = [
            for (final e in find.byType(Text).evaluate()) (e.widget as Text).data,
            for (final e in find.byType(SelectableText).evaluate()) (e.widget as SelectableText).data,
          ].whereType<String>().join(' | ');
          fail('timed out waiting for $f  screen: $shown');
        }
        await tester.runAsync(() => Future.delayed(const Duration(milliseconds: 400)));
        await tester.pump(const Duration(milliseconds: 400)); // advances the app's timers too
      }
    }

    // ── 2. Passcode, twice.
    for (var r = 0; r < 2; r++) {
      for (final k in '135790'.split('')) {
        await tester.tap(find.text(k).first);
        await tester.pump();
      }
      await tester.pumpAndSettle();
    }

    // ── 3. Send tab → import the vault file.
    await tester.tap(find.byIcon(Icons.send_outlined).first);
    await tester.pumpAndSettle();
    await waitFor(find.text('Import vault file'));
    await tester.tap(find.text('Import vault file'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, cliJson(ui, await tester.runAsync(ui.owner.address) as String));
    await tester.tap(find.text('Save'));
    await tester.pump();
    await waitFor(find.textContaining('Fee key:'));

    // The app made a fresh fee key; give it devnet SOL.
    await tester.runAsync(() async {
      final k = (await KeyStore('devnet').load())!;
      final m = Message.compile(fee, [transferSol(fee, await k.payer.address(), 20000000)], await chain.latestBlockhash());
      await chain.confirm(await chain.send(await signTx(m, [payer])));
    });

    // ── 4. Fill the form like a person.
    await tester.enterText(find.byType(TextField).at(0), fee);
    await tester.enterText(find.byType(TextField).at(1), '0.5');
    await tester.pump();
    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(find.textContaining('0.5 QC'), findsOneWidget); // confirmation dialog shows amount + recipient
    await tester.tap(find.widgetWithText(FilledButton, 'Send'));
    await tester.pump();

    // ── 5. Progress, then success with explorer link.
    await waitFor(find.textContaining('Sent\n'), seconds: 180);
    expect(authAsked, 1);
    final w = find.textContaining('Sent\n').evaluate().first.widget;
    final shown = switch (w) {
      Text(:final data) || SelectableText(:final data) => data!,
      RichText(:final text) => text.toPlainText(),
      EditableText(:final controller) => controller.text,
      _ => fail('unexpected ${w.runtimeType}'),
    };
    final sig = shown.split('\n')[1];
    expect(shown, contains('explorer.solana.com/tx/$sig'));
    // ignore: avoid_print
    print('ui send: $sig');

    // ── 6. On chain: old vault marked spent, remainder in the rotated vault, keys saved.
    await tester.runAsync(() async {
      final k = (await KeyStore('devnet').load())!;
      await saveCli('$uiName-next', k.vault);
      expect(await chain.accountOwner((await ui.vault()).$1), qcProgram);
      expect(await chain.balance([await k.vault.vaultTokenAccount(chain.mint)]), BigInt.from(150000));
      expect(prefs.getString('vault'), (await k.vault.vault()).$1); // app switched to the new vault
    });
    // ignore: avoid_print
    print('ui e2e verified on chain');
    await tester.pumpWidget(const SizedBox());
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 30)); // let the HTTP keep-alive timers expire
    }
  }, timeout: const Timeout(Duration(minutes: 8)));
}
