import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/keystore.dart';
import 'package:quantum_safe/wallet.dart';

void main() {
  test('amount parsing', () {
    expect(parseUnits('1'), BigInt.from(100000));
    expect(parseUnits('0.5'), BigInt.from(50000));
    expect(parseUnits('12,00001'), BigInt.from(1200001));
    expect(parseUnits('0.000001'), isNull); // more than 5 decimals
    expect(parseUnits('abc'), isNull);
    expect(parseUnits(''), isNull);
  });

  test('keys survive a save/load round trip, pending send included', () {
    final k = Keys(EdKey.fresh(), VaultKeys.fresh(EdKey.fresh()));
    k.vault.signed = 'ab' * 24;
    k.pending = Pending('7Xu64rz6VvqzGK9TtwWh4C9DAsp3WZTec2MWNpuYosh2', BigInt.from(42), VaultKeys.fresh(k.vault.owner));
    final back = Keys.fromJson(k.toJson());
    expect(back.payer.seed, k.payer.seed);
    expect(back.vault.signed, k.vault.signed);
    expect(back.vault.master, k.vault.master);
    expect(back.pending!.amount, BigInt.from(42));
    expect(back.pending!.next.seed, k.pending!.next.seed);
  });
}
