import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/pda.dart';

void main() {
  test('base58 round-trips', () {
    const a = 'BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8';
    expect(b58encode(b58decode(a)), a);
    expect(b58decode(a).length, 32);
  });

  test('on-curve check', () {
    expect(isOnCurve(b58decode(Chain.mints['devnet']!)), isTrue); // keypair address
    expect(isOnCurve(b58decode('7x8zcyKjwEsumvkkRQRtSNizuWUMCi1AsUSre4vjLLh6')), isFalse); // PDA
  });

  // Reference: client/allocations-devnet.json (alloc-founder), made by spl-token.
  test('associated token address matches spl-token', () {
    expect(associatedTokenAddress('7x8zcyKjwEsumvkkRQRtSNizuWUMCi1AsUSre4vjLLh6', Chain.mints['devnet']!),
        '3vYAe7m93Cd9F6SN4LyJsBQyXQSyftHqPoXJxSXZ3tBK');
  });
}
