import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/data.dart';
import 'package:quantum_safe/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

const genesisVault = 'Bfs2aWwiippbnT2qb6jWQzAsXs2qC7cmvcXrDRHXwkdU';

void main() {
  test('address checks', () {
    expect(checkAddress(''), AddrCheck.empty);
    expect(checkAddress('0x52908400098527886E0F7030069857D2E4169EE7'), AddrCheck.ethereum);
    expect(checkAddress('not an address'), AddrCheck.invalid);
    expect(checkAddress(genesisVault), AddrCheck.ok);
    final saved = genesisVault;
    final fake = '${saved.substring(0, 4)}${'1' * 36}${saved.substring(saved.length - 4)}';
    expect(checkAddress(fake, contacts: [saved]), AddrCheck.lookalike);
  });

  test('unit formatting', () {
    expect(fmtUnits(BigInt.parse('128400000000')), '1,284,000');
    expect(fmtUnits(BigInt.from(150000)), '1.5');
    expect(fmtUnits(BigInt.zero), '0');
  });

  testWidgets('first run asks for a passcode twice, then shows empty vault', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(QuantumSafe(prefs: prefs));
    await tester.pumpAndSettle();
    expect(find.text('Choose a 6-digit passcode'), findsOneWidget);
    for (var r = 0; r < 2; r++) {
      for (final k in '246810'.split('')) {
        await tester.tap(find.text(k).first);
        await tester.pump();
      }
      await tester.pumpAndSettle();
    }
    expect(prefs.getString('codeHash'), isNotNull);
    expect(prefs.getString('codeHash'), isNot(contains('246810')));
    expect(find.text('No vault added yet'), findsOneWidget);
  });
}
