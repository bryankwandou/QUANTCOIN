// A vault's one-time key may sign exactly one transfer. Once that signature
// is broadcast the vault can only ever finish it, so a transfer the program
// is certain to reject (too much, own vault, bad address) must be refused
// before signing, and a send that stopped before broadcasting must be droppable.
// Runs offline against a fake RPC.
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/chain.dart';
import 'package:quantum_safe/data.dart';
import 'package:quantum_safe/keystore.dart';
import 'package:quantum_safe/pda.dart';
import 'package:quantum_safe/wallet.dart';

class FakeChain extends Chain {
  FakeChain() : super('mainnet');
  final owners = <String, String>{};
  BigInt held = BigInt.from(1000000);
  int sol = 1000000000; // fee key balance, lamports
  int failSendNo = 0; // 1 = prep tx, 2 = spend tx
  final sent = <String>[];

  @override
  Future<String?> accountOwner(String address) async => owners[address];
  @override
  Future<BigInt> tokenAmount(String address) async => held;
  @override
  Future<int> solBalance(String address) async => sol;
  @override
  Future<int> rentExempt(int bytes) async => (bytes + 128) * 6960;
  @override
  Future<String> latestBlockhash() async => 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
  @override
  Future<String> send(String base64Tx) async {
    sent.add(base64Tx);
    if (sent.length == failSendNo) throw ChainError('RPC 503');
    return '${sent.length}';
  }
  @override
  Future<void> confirm(String sig, {Duration timeout = const Duration(seconds: 60)}) async {}
}

void main() {
  late KeyStore store;
  late Keys k;
  late FakeChain chain;
  late String friend;

  setUp(() async {
    FlutterSecureStorage.setMockInitialValues({});
    store = KeyStore('mainnet');
    k = await store.create();
    chain = FakeChain();
    friend = await EdKey.fresh().address();
  });

  Future<void> refused(String to, BigInt amount, Matcher why) async {
    await expectLater(store.send(k, chain, to, amount), throwsA(why));
    expect(chain.sent, isEmpty, reason: 'nothing may be broadcast');
    expect(k.vault.signed, isNull, reason: 'the one-time key must stay unused');
    expect(k.pending, isNull, reason: 'a refused send must not block the next one');
  }

  test('a truncated address is not a Solana address', () {
    const good = 'AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2';
    expect(checkAddress(good), AddrCheck.ok);
    // Still valid base58 of a plausible length, but not 32 bytes.
    expect(checkAddress(good.substring(0, 42)), AddrCheck.invalid);
    expect(checkAddress('z' * 44), AddrCheck.invalid);
    expect(() => pubkey(good.substring(0, 42)), throwsFormatException);
  });

  test('more than the vault holds is refused before signing', () async {
    chain.held = BigInt.from(100);
    await refused(friend, BigInt.from(101), isStateError);
  });

  test('sending to its own vault is refused before signing', () async {
    await refused((await k.vault.vault()).$1, BigInt.one, isStateError);
  });

  test('a token account, a mint or a spent vault is not a recipient', () async {
    for (final o in [token2022, tokenProgram, qcProgram]) {
      chain.owners[friend] = o;
      await refused(friend, BigInt.one, isStateError);
    }
  });

  test('a program, sysvar or the incinerator is not a recipient', () async {
    for (final o in ['BPFLoaderUpgradeab1e11111111111111111111111', 'NativeLoader1111111111111111111111111111111',
        'Sysvar1111111111111111111111111111111111111']) {
      chain.owners[friend] = o;
      await refused(friend, BigInt.one, isStateError);
    }
    chain.owners.remove(friend);
    await refused('1nc1nerator11111111111111111111111111111111', BigInt.one, isStateError);
  });

  test('a fee key without enough SOL is refused before anything is sent', () async {
    // two new token accounts (170 bytes each) + three signatures
    final need = 2 * (170 + 128) * 6960 + 15000;
    chain.sol = need - 1;
    await refused(friend, BigInt.one, isStateError);
    // the recipient's account already exists: one account less to pay for
    chain.owners[associatedTokenAddress(friend, chain.mint)] = token2022;
    chain.sol = need - (170 + 128) * 6960;
    await store.send(k, chain, friend, BigInt.one);
    expect(chain.sent, hasLength(2));
  });

  test('a truncated recipient is refused before signing', () async {
    await refused(friend.substring(0, friend.length - 2), BigInt.one, isFormatException);
  });

  test('a spent vault does not sign again', () async {
    chain.owners[(await k.vault.vault()).$1] = qcProgram;
    await refused(friend, BigInt.one, isStateError);
  });

  test('a send that failed before broadcasting the signature can be corrected', () async {
    chain.failSendNo = 1; // the account-creation tx fails
    await expectLater(store.send(k, chain, friend, BigInt.one), throwsA(isA<ChainError>()));
    expect(k.vault.signed, isNull);
    expect((await store.load())!.pending, isNull);
    chain
      ..failSendNo = 0
      ..sent.clear();
    final other = await EdKey.fresh().address();
    await store.send(k, chain, other, BigInt.two);
    expect(chain.sent, hasLength(2));
  });

  test('once the signature is broadcast only that transfer can finish', () async {
    chain.failSendNo = 2; // the spend itself fails in flight
    await expectLater(store.send(k, chain, friend, BigInt.one), throwsA(isA<ChainError>()));
    final back = (await store.load())!;
    expect(back.vault.signed, isNotNull);
    expect(back.pending!.recipient, friend);
    await expectLater(store.send(back, chain, friend, BigInt.two), throwsStateError);
    chain.failSendNo = 0;
    await store.send(back, chain, friend, BigInt.one); // resume, same digest
    expect(back.pending, isNull);
    expect(back.vault.signed, isNull, reason: 'rotated to the fresh vault');
  });
}
